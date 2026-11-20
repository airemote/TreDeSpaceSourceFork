// The slice of WebXR (https://immersive-web.github.io/webxr/), the WebXR/WebGPU
// binding (https://immersive-web.github.io/webxr-webgpu-binding/) and the
// anchors module the headset session uses. TypeScript's DOM lib ships none of
// them; declaring the members used here keeps a types package (and its
// notice) out of the dependencies. Names carry an `Xr` prefix so they never
// collide with a future DOM lib's `XR*` globals.

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type XrSessionMode = 'immersive-vr' | 'immersive-ar';
export type XrHandedness = 'none' | 'left' | 'right';

export interface XrRigidTransform {
  readonly position: DOMPointReadOnly;
  readonly orientation: DOMPointReadOnly;
  /** Column-major 4×4. */
  readonly matrix: Float32Array;
  readonly inverse: XrRigidTransform;
}

export interface XrView {
  readonly eye: 'none' | 'left' | 'right';
  /** Column-major; with the WebGPU binding its clip depth is [0, 1]. */
  readonly projectionMatrix: Float32Array;
  readonly transform: XrRigidTransform;
}

export interface XrPose {
  readonly transform: XrRigidTransform;
}

export interface XrViewerPose extends XrPose {
  readonly views: readonly XrView[];
}

export type XrSpace = EventTarget;

export interface XrReferenceSpace extends XrSpace {
  getOffsetReferenceSpace(originOffset: XrRigidTransform): XrReferenceSpace;
}

export interface XrInputSource {
  readonly handedness: XrHandedness;
  readonly targetRayMode: 'gaze' | 'tracked-pointer' | 'screen' | 'transient-pointer';
  readonly targetRaySpace: XrSpace;
  readonly gripSpace?: XrSpace;
  readonly gamepad?: Gamepad;
}

/** `select` / `squeeze` events carry the source that fired them. */
export interface XrInputSourceEvent extends Event {
  readonly inputSource: XrInputSource;
}

export interface XrAnchor {
  readonly anchorSpace: XrSpace;
  delete(): void;
  /** Anchors persistence (Quest browser): a UUID that survives the session. */
  requestPersistentHandle?(): Promise<string>;
}

export interface XrFrame {
  getViewerPose(space: XrReferenceSpace): XrViewerPose | null;
  getPose(space: XrSpace, baseSpace: XrSpace): XrPose | null;
  /** Anchors module — present when the session enabled 'anchors'. */
  createAnchor?(pose: XrRigidTransform, space: XrSpace): Promise<XrAnchor>;
  readonly trackedAnchors?: ReadonlySet<XrAnchor>;
}

export type XrRenderStateInit = Readonly<{
  layers?: readonly XrProjectionLayer[];
  depthNear?: number;
  depthFar?: number;
}>;

export interface XrSession extends EventTarget {
  readonly enabledFeatures?: readonly string[];
  readonly inputSources: Iterable<XrInputSource>;
  readonly environmentBlendMode?: 'opaque' | 'alpha-blend' | 'additive';
  requestReferenceSpace(type: 'local' | 'local-floor' | 'viewer'): Promise<XrReferenceSpace>;
  requestAnimationFrame(callback: (time: number, frame: XrFrame) => void): number;
  cancelAnimationFrame(handle: number): void;
  updateRenderState(state: XrRenderStateInit): void;
  end(): Promise<void>;
  restorePersistentAnchor?(uuid: string): Promise<XrAnchor>;
  deletePersistentAnchor?(uuid: string): Promise<void>;
}

export type XrSessionInit = Readonly<{
  requiredFeatures?: readonly string[];
  optionalFeatures?: readonly string[];
}>;

export interface XrSystem extends EventTarget {
  isSessionSupported(mode: XrSessionMode): Promise<boolean>;
  requestSession(mode: XrSessionMode, init: XrSessionInit): Promise<XrSession>;
}

export interface XrProjectionLayer {
  readonly textureWidth: number;
  readonly textureHeight: number;
  /** 0 = none … 1 = strongest; null where unsupported. */
  fixedFoveation?: number | null;
}

export interface XrGpuSubImage {
  readonly viewport: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly colorTexture: GPUTexture;
  readonly depthStencilTexture: GPUTexture | null;
  getViewDescriptor(): GPUTextureViewDescriptor;
}

export type XrGpuProjectionLayerInit = Readonly<{
  colorFormat: GPUTextureFormat;
  depthStencilFormat?: GPUTextureFormat;
  textureUsage?: number;
  scaleFactor?: number;
}>;

export interface XrGpuBinding {
  readonly nativeProjectionScaleFactor: number;
  getPreferredColorFormat(): GPUTextureFormat;
  createProjectionLayer(init: XrGpuProjectionLayerInit): XrProjectionLayer;
  getViewSubImage(layer: XrProjectionLayer, view: XrView): XrGpuSubImage;
}

export type XrGpuBindingConstructor = new (session: XrSession, device: GPUDevice) => XrGpuBinding;
export type XrRigidTransformConstructor = new (position: DOMPointInit, orientation: DOMPointInit) => XrRigidTransform;

declare global {
  interface Navigator {
    /** WebXR — Chromium browsers on secure origins (and the Quest browser). */
    readonly xr?: XrSystem;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isConstructor<T>(value: unknown): value is T {
  return typeof value === 'function';
}

/** Narrows a session event to an input-source event (select / squeeze). */
export function isInputSourceEvent(e: Event): e is XrInputSourceEvent {
  return 'inputSource' in e && typeof e.inputSource === 'object' && e.inputSource !== null;
}

/** The WebXR entry point, or null where the browser has none. */
export function getXr(): XrSystem | null {
  return typeof navigator !== 'undefined' && navigator.xr ? navigator.xr : null;
}

/** `XRGPUBinding` — only where the browser exposes WebXR over WebGPU (behind
 *  flags as of 2026-11). */
export function getGpuBindingConstructor(): XrGpuBindingConstructor | null {
  const ctor: unknown = Reflect.get(globalThis, 'XRGPUBinding');

  return isConstructor<XrGpuBindingConstructor>(ctor) ? ctor : null;
}

/** `XRRigidTransform` — needed to place an anchor. */
export function getRigidTransformConstructor(): XrRigidTransformConstructor | null {
  const ctor: unknown = Reflect.get(globalThis, 'XRRigidTransform');

  return isConstructor<XrRigidTransformConstructor>(ctor) ? ctor : null;
}
