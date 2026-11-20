// The GPU passes only a headset frame runs (Renderer.frameXr): the controller
// ray pick, the depth hand-off to the XR compositor and the desktop mirror.
// Pipelines are built on first use, so a viewer that never enters XR never
// compiles them.

import { XR_RAY_COUNT, xrDepthWgsl, xrMirrorWgsl, xrRayPickWgsl } from './shaders';
import type { Vec3, ViewCamera } from './viewCamera';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** A target rectangle in device pixels. */
export type XrViewport = Readonly<{ x: number; y: number; width: number; height: number }>;

/** One eye of a headset frame: its camera and the projection-layer slice it
 *  renders into. `depth` is set when depth goes to the compositor, with the
 *  headset projection's depth terms (p[10], p[14]) to convert into. */
export type XrViewTarget = Readonly<{
  camera: ViewCamera;
  color: GPUTextureView;
  viewport: XrViewport;
  depth: Readonly<{ view: GPUTextureView; p10: number; p14: number }> | null;
}>;

/** A controller ray in the eye space of the frame's LAST view. */
export type XrRay = Readonly<{ origin: Vec3; dir: Vec3; maxDist: number }>;

/** What a ray hit: the packed global item id (null = background) and the
 *  distance along the ray. */
export type XrRayHit = Readonly<{ id: number | null; dist: number }>;

export type XrFrameOptions = Readonly<{
  /** Passthrough AR: the background stays clear. */
  ar: boolean;
  msaa: boolean;
  /** Copy the last eye to the desktop canvas. */
  mirror: boolean;
  /** One slot per controller; null = no ray this frame. */
  rays: readonly (XrRay | null)[];
}>;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** The projection layer's depth format when depth is handed to the compositor. */
export const XR_DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/** RayParams: XR_RAY_COUNT × (origin, dir) + proj + near, all vec4f. */
const RAY_PARAMS_BYTES = (XR_RAY_COUNT * 2 + 2) * 16;
const HITS_BYTES = XR_RAY_COUNT * 16;

// -----------------------------------------------------------------------------
// Passes
// -----------------------------------------------------------------------------

export class XrPasses {
  private dev: GPUDevice | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';
  private rayPipelines: Partial<Record<'x1' | 'x4', GPUComputePipeline>> = {};
  private depthPipelines: Partial<Record<'x1' | 'x4', GPURenderPipeline>> = {};
  private mirrorPipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private rayParams: GPUBuffer | null = null;
  private hitsBuf: GPUBuffer | null = null;
  private hitsRead: GPUBuffer | null = null;
  private depthParams: GPUBuffer | null = null;
  private isRayInFlight = false;
  private latest: (XrRayHit | null)[] = Array.from({ length: XR_RAY_COUNT }, () => null);

  init(dev: GPUDevice, format: GPUTextureFormat): void {
    this.dev = dev;
    this.format = format;
  }

  /** The newest ray results, one per ray slot (a frame or two behind the rays). */
  get hits(): readonly (XrRayHit | null)[] {
    return this.latest;
  }

  /** Forget the last results (session end). */
  clearHits(): void {
    this.latest = this.latest.map(() => null);
  }

  /** March the rays against the eye just rendered (its depth + id G-buffer).
   *  Returns the post-submit readback job, or null while one is in flight. */
  encodeRayPick(
    enc: GPUCommandEncoder,
    depth: GPUTexture,
    ids: GPUTexture,
    msaa: boolean,
    rays: readonly (XrRay | null)[],
    cam: ViewCamera,
  ): (() => void) | null {
    const dev = this.dev;
    if (!dev || this.isRayInFlight) {
      return null;
    }

    const pipeline = this.rayPipeline(dev, msaa);
    this.rayParams ??= dev.createBuffer({
      label: 'xrRayParams',
      size: RAY_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.hitsBuf ??= dev.createBuffer({
      label: 'xrRayHits',
      size: HITS_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.hitsRead ??= dev.createBuffer({
      label: 'xrRayHitsRead',
      size: HITS_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const params = new Float32Array(RAY_PARAMS_BYTES / 4);
    for (let i = 0; i < XR_RAY_COUNT; i++) {
      const ray = rays[i];
      if (ray) {
        params.set([...ray.origin, 1, ...ray.dir, ray.maxDist], i * 8);
      }
    }
    params.set([cam.p00, cam.p11, cam.p20, cam.p21, cam.near, 0, 0, 0], XR_RAY_COUNT * 8);
    dev.queue.writeBuffer(this.rayParams, 0, params);
    const bind = dev.createBindGroup({
      label: 'xrRayBind',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: depth.createView() },
        { binding: 1, resource: ids.createView() },
        { binding: 2, resource: { buffer: this.rayParams } },
        { binding: 3, resource: { buffer: this.hitsBuf } },
      ],
    });
    const pass = enc.beginComputePass({ label: 'xrRayPick' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(this.hitsBuf, 0, this.hitsRead, 0, HITS_BYTES);
    this.isRayInFlight = true;
    const read = this.hitsRead;

    return () => {
      void this.resolveHits(read);
    };
  }

  /** Write the eye's depth into the layer's depth slice, in the headset
   *  projection's depth convention. */
  encodeDepth(
    enc: GPUCommandEncoder,
    src: GPUTexture,
    msaa: boolean,
    target: GPUTextureView,
    viewport: XrViewport,
    p10: number,
    p14: number,
    near: number,
  ): void {
    const dev = this.dev;
    if (!dev) {
      return;
    }

    const pipeline = this.depthPipeline(dev, msaa);
    this.depthParams ??= dev.createBuffer({
      label: 'xrDepthParams',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(this.depthParams, 0, new Float32Array([p10, p14, near, 0]));
    const bind = dev.createBindGroup({
      label: 'xrDepthBind',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: { buffer: this.depthParams } },
      ],
    });
    const pass = enc.beginRenderPass({
      label: 'xrDepth',
      colorAttachments: [],
      depthStencilAttachment: { view: target, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
  }

  /** Letterbox `src` (one eye's finished image) into the desktop canvas. */
  encodeMirror(enc: GPUCommandEncoder, src: GPUTexture, target: GPUTextureView, targetW: number, targetH: number) {
    const dev = this.dev;
    if (!dev || targetW === 0 || targetH === 0) {
      return;
    }

    this.mirrorPipeline ??= this.buildMirror(dev);
    this.sampler ??= dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const bind = dev.createBindGroup({
      label: 'xrMirrorBind',
      layout: this.mirrorPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });
    const scale = Math.min(targetW / src.width, targetH / src.height);
    const w = src.width * scale;
    const h = src.height * scale;
    const pass = enc.beginRenderPass({
      label: 'xrMirror',
      colorAttachments: [{ view: target, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setViewport((targetW - w) / 2, (targetH - h) / 2, w, h, 0, 1);
    pass.setPipeline(this.mirrorPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private async resolveHits(buf: GPUBuffer): Promise<void> {
    try {
      await buf.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(buf.getMappedRange().slice(0));
      buf.unmap();
      const floats = new Float32Array(words.buffer);
      this.latest = this.latest.map((_, i) => {
        if (words[i * 4 + 2] === 0) {
          return null;
        }
        const id = words[i * 4];

        return { id: id === 0 ? null : id >>> 0, dist: floats[i * 4 + 1] };
      });
    } catch {
      this.clearHits();
    } finally {
      this.isRayInFlight = false;
    }
  }

  private rayPipeline(dev: GPUDevice, msaa: boolean): GPUComputePipeline {
    const key = msaa ? 'x4' : 'x1';
    const cached = this.rayPipelines[key];
    if (cached) {
      return cached;
    }

    const module = dev.createShaderModule({ label: 'xrRayPick', code: xrRayPickWgsl(msaa) });
    const pipeline = dev.createComputePipeline({ label: 'xrRayPick', layout: 'auto', compute: { module } });
    this.rayPipelines[key] = pipeline;

    return pipeline;
  }

  private depthPipeline(dev: GPUDevice, msaa: boolean): GPURenderPipeline {
    const key = msaa ? 'x4' : 'x1';
    const cached = this.depthPipelines[key];
    if (cached) {
      return cached;
    }

    const module = dev.createShaderModule({ label: 'xrDepth', code: xrDepthWgsl(msaa) });
    const pipeline = dev.createRenderPipeline({
      label: 'xrDepth',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: XR_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
    });
    this.depthPipelines[key] = pipeline;

    return pipeline;
  }

  private buildMirror(dev: GPUDevice): GPURenderPipeline {
    const module = dev.createShaderModule({ label: 'xrMirror', code: xrMirrorWgsl() });

    return dev.createRenderPipeline({
      label: 'xrMirror',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }
}
