// A headset session (VR, or passthrough AR) over the WebXR/WebGPU binding:
// start-up, the per-frame loop that feeds Renderer.frameXr, the controllers,
// and the AR alignment anchor. App-agnostic — the caller passes hooks for
// selection, saved alignments, stats and the session end.

import { MARKER_INSTANCE_FLOATS, writeMarkerInstance } from '../render/markerInstance';
import type { Renderer } from '../render/renderer';
import type { Vec3 } from '../render/viewCamera';
import { XR_DEPTH_FORMAT, type XrRay, type XrViewTarget } from '../render/xrPasses';
import type { Result } from '../result';
import {
  getGpuBindingConstructor,
  getRigidTransformConstructor,
  getXr,
  isInputSourceEvent,
  type XrAnchor,
  type XrFrame,
  type XrGpuBinding,
  type XrInputSource,
  type XrProjectionLayer,
  type XrReferenceSpace,
  type XrSession,
} from './webxr';
import { type PadButtons, type PadState, pressedSince, readPad, releasedSince, stepLocomotion } from './xrControls';
import {
  eyeCamera,
  followPose,
  fromXr,
  type Mat4d,
  moveRig,
  multiply,
  poseParts,
  poseRay,
  rigFromCamera,
  rigidInverse,
  turnRig,
  type WorldPose,
  worldPose,
  yawOnly,
} from './xrMath';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type XrMode = 'vr' | 'ar';

/** Per-session render settings (Settings › XR). */
export type XrRunSettings = Readonly<{
  /** Projection-layer resolution scale (1 = the headset's recommended size). */
  renderScale: number;
  msaa: boolean;
  /** Fixed foveation, 0 (off) … 1 (strongest), where the headset supports it. */
  foveation: number;
  snapTurnDeg: number;
  /** Show the last eye on the desktop canvas. */
  mirror: boolean;
  /** Hand the compositor our depth (better reprojection). */
  sendDepth: boolean;
}>;

/** An AR alignment kept across sessions: a persistent anchor and the world
 *  transform relative to it (column-major 4×4, world → anchor space). */
export type XrSavedAlignment = Readonly<{ anchor: string; offset: readonly number[] }>;

export type XrSessionHooks = Readonly<{
  /** Move and sprint speed, metres per second — read every frame. */
  speeds: () => Readonly<{ move: number; sprint: number }>;
  /** Select (trigger, or a hand pinch): the packed global item id under the ray (null = nothing). */
  onSelect: (globalId: number | null) => void;
  onAlignmentSaved: (alignment: XrSavedAlignment) => void;
  onFps: (fps: number) => void;
  onMessage: (text: string) => void;
  /** The session is over; `pose` is where the user stood (world), if known. */
  onEnd: (pose: WorldPose | null) => void;
}>;

export type XrStartOptions = Readonly<{
  mode: XrMode;
  renderer: Renderer;
  settings: XrRunSettings;
  /** The desktop camera: the session starts standing there. */
  start: WorldPose;
  near: number;
  /** A saved AR alignment for this scene, restored when the anchor is found. */
  alignment: XrSavedAlignment | null;
  hooks: XrSessionHooks;
}>;

export type XrSessionHandle = Readonly<{ end: () => void }>;

type Hold = Readonly<{ rig0: Mat4d; pose0: Mat4d }>;
type Grab = Hold & Readonly<{ slot: number }>;
type ControllerFrame = Readonly<{ pad: PadState; ray: Mat4d | null; grip: Mat4d | null }>;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Far plane handed to the session (the renderer's own projection is infinite;
 *  this only shapes the headset matrices the depth hand-off converts into). */
const XR_DEPTH_FAR = 100_000;
/** How far a ray is marched for a hit, and drawn when it hits nothing (m). */
const RAY_MAX_DIST = 1000;
const RAY_MISS_LENGTH = 5;
/** Reticle radius per metre of distance, and its floor. */
const RETICLE_PER_METRE = 0.006;
const RETICLE_MIN = 0.008;
const RAY_HIT_COLOR = packColor(56, 189, 248);
const RAY_MISS_COLOR = packColor(148, 163, 184);
const RETICLE_RGBA: readonly [number, number, number, number] = [0.22, 0.74, 0.97, 1];
const MAX_FRAME_DT = 0.1;
const FPS_WINDOW_MS = 1000;
/** Controller slots: rays, buttons and hits are indexed by these. */
const LEFT = 0;
const RIGHT = 1;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function packColor(r: number, g: number, b: number): number {
  return (r | (g << 8) | (b << 16) | (255 << 24)) >>> 0;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function slotOf(source: XrInputSource): number {
  return source.handedness === 'left' ? LEFT : RIGHT;
}

// -----------------------------------------------------------------------------
// The running session
// -----------------------------------------------------------------------------

class XrRunner {
  private rig: Mat4d;
  private readonly startRig: Mat4d;
  private head: Mat4d | null = null;
  private lastT = 0;
  private isTurnArmed = true;
  private prevButtons: (PadButtons | null)[] = [null, null];
  private grab: Grab | null = null;
  private lock: Hold | null = null;
  /** A restored alignment: applied every frame its anchor is tracked, until the user moves the model. */
  private anchored: Readonly<{ anchor: XrAnchor; offset: Mat4d }> | null = null;
  private savedAnchorId: string | null;
  private frames = 0;
  private fpsT = 0;
  private handle = 0;
  private readonly o: XrStartOptions;
  private readonly session: XrSession;
  private readonly binding: XrGpuBinding;
  private readonly layer: XrProjectionLayer;
  private readonly space: XrReferenceSpace;

  constructor(
    o: XrStartOptions,
    session: XrSession,
    binding: XrGpuBinding,
    layer: XrProjectionLayer,
    space: XrReferenceSpace,
  ) {
    this.o = o;
    this.session = session;
    this.binding = binding;
    this.layer = layer;
    this.space = space;
    this.startRig = rigFromCamera(o.start.eye, o.start.forward);
    this.rig = this.startRig;
    this.savedAnchorId = o.alignment?.anchor ?? null;
  }

  start(): void {
    this.handle = this.session.requestAnimationFrame(this.onFrame);
    this.session.addEventListener('select', this.onSelect);
    if (this.o.mode === 'ar' && this.o.alignment) {
      void this.restoreAlignment(this.o.alignment);
    }
  }

  stop(): WorldPose | null {
    this.session.cancelAnimationFrame(this.handle);
    this.session.removeEventListener('select', this.onSelect);
    this.anchored?.anchor.delete();
    this.anchored = null;

    return this.head ? worldPose(this.rig, this.head) : null;
  }

  private readonly onFrame = (t: number, frame: XrFrame): void => {
    this.handle = this.session.requestAnimationFrame(this.onFrame);
    const pose = frame.getViewerPose(this.space);
    if (!pose) {
      return;
    }

    const dt = this.lastT > 0 ? Math.min(MAX_FRAME_DT, (t - this.lastT) / 1000) : 0;
    this.lastT = t;
    this.head = fromXr(pose.transform.matrix);
    const controllers = this.readControllers(frame);
    this.applyInput(frame, controllers, dt);
    this.followAnchor(frame);

    const targets = pose.views.map((view): XrViewTarget => {
      const sub = this.binding.getViewSubImage(this.layer, view);
      const desc = sub.getViewDescriptor();
      const { width, height } = sub.viewport;
      const proj = view.projectionMatrix;

      return {
        camera: eyeCamera(view.transform.inverse.matrix, proj, this.rig, this.o.near, width, height),
        color: sub.colorTexture.createView(desc),
        viewport: sub.viewport,
        depth: sub.depthStencilTexture
          ? { view: sub.depthStencilTexture.createView(desc), p10: proj[10], p14: proj[14] }
          : null,
      };
    });
    const lastView = pose.views[pose.views.length - 1];
    const lastEye = lastView ? fromXr(lastView.transform.inverse.matrix) : null;
    const rays = controllers.map((c): XrRay | null => {
      if (!c.ray || !lastEye) {
        return null;
      }
      const r = poseRay(lastEye, c.ray);

      return { origin: r.origin, dir: r.dir, maxDist: RAY_MAX_DIST };
    });
    this.writeOverlay(controllers);
    const { settings } = this.o;
    this.o.renderer.frameXr(targets, { ar: this.o.mode === 'ar', msaa: settings.msaa, mirror: settings.mirror, rays });
    this.countFrame(t);
  };

  /** WebXR's primary action — the controller trigger, and a pinch with hand
   *  tracking — selects what that source's ray points at. */
  private readonly onSelect = (e: Event): void => {
    if (!isInputSourceEvent(e) || this.grab) {
      return;
    }

    this.o.hooks.onSelect(this.o.renderer.xrRayHits[slotOf(e.inputSource)]?.id ?? null);
  };

  /** Both controller slots this frame: pad state and the ray / grip poses. */
  private readControllers(frame: XrFrame): ControllerFrame[] {
    const out: ControllerFrame[] = [
      { pad: readPad(undefined), ray: null, grip: null },
      { pad: readPad(undefined), ray: null, grip: null },
    ];
    for (const source of this.session.inputSources) {
      if (source.targetRayMode !== 'tracked-pointer') {
        continue;
      }
      const ray = frame.getPose(source.targetRaySpace, this.space);
      const grip = source.gripSpace ? frame.getPose(source.gripSpace, this.space) : ray;
      out[slotOf(source)] = {
        pad: readPad(source.gamepad),
        ray: ray ? fromXr(ray.transform.matrix) : null,
        grip: grip ? fromXr(grip.transform.matrix) : null,
      };
    }

    return out;
  }

  /** Locomotion, grab, the align lock and reset — in that order (select is
   *  the session's `select` event, see onSelect). */
  private applyInput(frame: XrFrame, controllers: readonly ControllerFrame[], dt: number): void {
    const head = this.head;
    if (!head) {
      return;
    }

    const left = controllers[LEFT].pad;
    const right = controllers[RIGHT].pad;
    const down = controllers.map((c, i) => pressedSince(this.prevButtons[i], c.pad.buttons));
    const up = controllers.map((c, i) => releasedSince(this.prevButtons[i], c.pad.buttons));
    this.prevButtons = controllers.map((c) => c.pad.buttons);

    if (!this.grab && !this.lock) {
      const speeds = this.o.hooks.speeds();
      const step = stepLocomotion({
        left,
        right,
        dt,
        speed: speeds.move,
        sprintSpeed: speeds.sprint,
        snapAngle: (this.o.settings.snapTurnDeg * Math.PI) / 180,
        headForward: worldPose(this.rig, head).forward,
        isTurnArmed: this.isTurnArmed,
      });
      this.isTurnArmed = step.isTurnArmed;
      if (step.move.some((v) => v !== 0)) {
        this.rig = moveRig(this.rig, step.move);
      }
      if (step.turn !== 0) {
        this.rig = turnRig(this.rig, [head[12], head[13], head[14]], step.turn);
      }
    }

    controllers.forEach((c, slot) => {
      if (down[slot].grip && c.grip && !this.grab) {
        this.grab = { slot, rig0: this.rig, pose0: c.grip };
        this.anchored = null;
      }
      if (up[slot].grip && this.grab?.slot === slot) {
        this.grab = null;
        this.saveAlignment(frame, c.grip ?? head);
      }
    });
    const grabPose = this.grab ? controllers[this.grab.slot].grip : null;
    if (this.grab && grabPose) {
      this.rig = followPose(this.grab.rig0, this.grab.pose0, grabPose);
    }

    if (down[RIGHT].primary && !this.lock) {
      this.lock = { rig0: this.rig, pose0: head };
      this.anchored = null;
    }
    if (this.lock) {
      this.rig = followPose(this.lock.rig0, this.lock.pose0, head);
    }
    if (up[RIGHT].primary && this.lock) {
      this.lock = null;
      this.saveAlignment(frame, head);
    }

    if (down[RIGHT].secondary) {
      this.rig = this.startRig;
      this.anchored = null;
      this.grab = null;
      this.lock = null;
    }
  }

  /** The controller rays and their hit reticles, in world space. */
  private writeOverlay(controllers: readonly ControllerFrame[]): void {
    const hits = this.o.renderer.xrRayHits;
    const toWorld = rigidInverse(this.rig);
    const lines = new Float32Array(controllers.length * 8);
    const colors = new Uint32Array(lines.buffer);
    const reticles: Vec3[] = [];
    const radii: number[] = [];
    let n = 0;
    controllers.forEach((c, slot) => {
      if (!c.ray) {
        return;
      }
      const ray = poseRay(toWorld, c.ray);
      const hit = hits[slot];
      const length = hit ? hit.dist : RAY_MISS_LENGTH;
      const end: Vec3 = [
        ray.origin[0] + ray.dir[0] * length,
        ray.origin[1] + ray.dir[1] * length,
        ray.origin[2] + ray.dir[2] * length,
      ];
      lines.set([...ray.origin, 0, ...end, 0], n * 8);
      colors[n * 8 + 3] = hit ? RAY_HIT_COLOR : RAY_MISS_COLOR;
      colors[n * 8 + 7] = colors[n * 8 + 3];
      n++;
      if (hit) {
        reticles.push(end);
        radii.push(Math.max(RETICLE_MIN, hit.dist * RETICLE_PER_METRE));
      }
    });
    const markers = new Float32Array(reticles.length * MARKER_INSTANCE_FLOATS);
    reticles.forEach((p, i) => {
      writeMarkerInstance(markers, i, p, radii[i], RETICLE_RGBA);
    });
    this.o.renderer.setXrOverlay(lines.subarray(0, n * 8), markers);
  }

  private countFrame(t: number): void {
    this.frames++;
    if (this.fpsT === 0) {
      this.fpsT = t;
    } else if (t - this.fpsT >= FPS_WINDOW_MS) {
      this.o.hooks.onFps((this.frames * 1000) / (t - this.fpsT));
      this.frames = 0;
      this.fpsT = t;
    }
  }

  // ---------------------------------------------------------------------------
  // AR alignment anchors
  // ---------------------------------------------------------------------------

  /** Keep the model where the user put it, across sessions: drop a
   *  persistent anchor at `pose` (heading + position) and store the world
   *  transform relative to it. AR only, and only where the browser offers
   *  persistent anchors. */
  private saveAlignment(frame: XrFrame, pose: Mat4d): void {
    const RigidTransform = getRigidTransformConstructor();
    if (this.o.mode !== 'ar' || !frame.createAnchor || !RigidTransform) {
      return;
    }

    const at = yawOnly(pose);
    const { position, orientation } = poseParts(at);
    const offset = multiply(rigidInverse(at), this.rig);
    void frame
      .createAnchor(new RigidTransform(position, orientation), this.space)
      .then(async (anchor) => {
        const id = await anchor.requestPersistentHandle?.();
        if (!id) {
          anchor.delete();
          this.o.hooks.onMessage('XR: this headset cannot keep anchors — the alignment lasts this session only');
          return;
        }
        const previous = this.savedAnchorId;
        this.savedAnchorId = id;
        if (previous && previous !== id) {
          void this.session.deletePersistentAnchor?.(previous).catch(() => undefined);
        }
        this.o.hooks.onAlignmentSaved({ anchor: id, offset: Array.from(offset) });
      })
      .catch((err: unknown) => {
        this.o.hooks.onMessage(`XR: could not save the alignment — ${errorMessage(err, 'anchor failed')}`);
      });
  }

  private async restoreAlignment(alignment: XrSavedAlignment): Promise<void> {
    if (!this.session.restorePersistentAnchor || alignment.offset.length !== 16) {
      return;
    }

    try {
      const anchor = await this.session.restorePersistentAnchor(alignment.anchor);
      this.anchored = { anchor, offset: Float64Array.from(alignment.offset) };
      this.o.hooks.onMessage('XR: saved alignment found — the model is placed where you left it');
    } catch {
      this.o.hooks.onMessage('XR: the saved alignment was not found here — starting from the desktop view');
    }
  }

  private followAnchor(frame: XrFrame): void {
    const a = this.anchored;
    if (!a || this.grab || this.lock || !(frame.trackedAnchors?.has(a.anchor) ?? true)) {
      return;
    }

    const pose = frame.getPose(a.anchor.anchorSpace, this.space);
    if (pose) {
      this.rig = multiply(fromXr(pose.transform.matrix), a.offset);
    }
  }
}

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

/** Why XR cannot start here, or null when it can try. */
export function xrUnavailableReason(renderer: Renderer): string | null {
  if (!getXr()) {
    return 'This browser has no WebXR (use the headset browser, or a Chromium browser on Windows — Linux has none).';
  }
  if (!getGpuBindingConstructor()) {
    return 'WebXR is here, but not over WebGPU: turn on the WebXR/WebGPU flags (Settings › XR) and restart the browser.';
  }
  if (!renderer.xrCompatible) {
    return 'The GPU adapter is not XR-compatible — reload the page with the headset connected.';
  }

  return null;
}

/**
 * Start a headset session. Must run inside a user gesture (a click or a key
 * press) — the browser refuses requestSession otherwise. The renderer stops
 * its desktop frames until the session ends; `hooks.onEnd` fires exactly
 * once, however it ends (the user leaves, the headset is taken off, `end()`).
 */
export async function startXrSession(o: XrStartOptions): Promise<Result<XrSessionHandle>> {
  const xr = getXr();
  const Binding = getGpuBindingConstructor();
  const unavailable = xrUnavailableReason(o.renderer);
  if (!xr || !Binding || unavailable) {
    return { error: { err: null, msg: unavailable ?? 'XR is not available' } };
  }

  let session: XrSession;
  try {
    session = await xr.requestSession(o.mode === 'ar' ? 'immersive-ar' : 'immersive-vr', {
      requiredFeatures: ['webgpu'],
      optionalFeatures: o.mode === 'ar' ? ['anchors'] : [],
    });
  } catch (err) {
    return { error: { err, msg: errorMessage(err, `The headset refused the ${o.mode.toUpperCase()} session`) } };
  }

  // one end listener from the first moment: a session can end during the
  // set-up below (the user takes the headset off), and only a session that
  // finished starting reports an end — a failed start reports its error
  let runner: XrRunner | null = null;
  let hasEnded = false;
  session.addEventListener(
    'end',
    () => {
      hasEnded = true;
      if (runner) {
        const pose = runner.stop();
        o.renderer.endXr();
        o.hooks.onEnd(pose);
      }
    },
    { once: true },
  );
  const fail = (err: unknown, msg: string): Result<XrSessionHandle> => {
    void session.end().catch(() => undefined);
    return { error: { err, msg } };
  };

  if (session.enabledFeatures && !session.enabledFeatures.includes('webgpu')) {
    return fail(null, 'The session started without WebGPU — check the WebXR/WebGPU flags');
  }

  try {
    const binding = new Binding(session, o.renderer.gpuDevice);
    const layer = binding.createProjectionLayer({
      colorFormat: o.renderer.colorFormat,
      depthStencilFormat: o.settings.sendDepth ? XR_DEPTH_FORMAT : undefined,
      scaleFactor: o.settings.renderScale,
    });
    if (layer.fixedFoveation !== undefined && layer.fixedFoveation !== null) {
      layer.fixedFoveation = o.settings.foveation;
    }
    session.updateRenderState({ layers: [layer], depthNear: o.near, depthFar: XR_DEPTH_FAR });
    const space = await session.requestReferenceSpace('local');
    if (hasEnded) {
      return { error: { err: null, msg: 'The headset ended the session while it started' } };
    }
    runner = new XrRunner(o, session, binding, layer, space);
    o.renderer.beginXr();
    runner.start();
  } catch (err) {
    return fail(err, errorMessage(err, 'Could not set up the headset layer'));
  }

  return { data: { end: () => void session.end().catch(() => undefined) } };
}
