// Pose math for the headset session — pure functions, f64 throughout.
//
// The RIG is the one transform between the viewer's world and WebXR: it maps
// world coordinates (Z-up, metres) into the session's reference space (Y-up,
// metres, gravity-aligned). Every way the user moves (stick locomotion, snap
// turn, grabbing the model, the align lock, a restored anchor) is a change of
// the rig — the XR reference space itself is never offset. The rig only ever
// holds a heading (rotation about the vertical) and a translation: tilting or
// scaling a CAD model off gravity is never wanted.
//
// Matrices are column-major 4×4 like WebXR's and the renderer's.

import type { Vec3, ViewCamera } from '../render/viewCamera';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type Mat4d = Float64Array;

/** An eye or head pose in world terms. */
export type WorldPose = Readonly<{ eye: Vec3; forward: Vec3 }>;

/** A ray: origin + unit direction. */
export type Ray3 = Readonly<{ origin: Vec3; dir: Vec3 }>;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Z-up world → Y-up XR: (x, y, z) → (x, z, −y), so world +Y looks along XR −Z. */
const Z_UP_TO_Y_UP: Mat4d = Float64Array.from([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
/** Below this horizontal length a direction counts as vertical. */
const VERTICAL_EPS = 1e-6;

// -----------------------------------------------------------------------------
// Matrix basics
// -----------------------------------------------------------------------------

export function multiply(a: Mat4d, b: Mat4d): Mat4d {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + r] * b[c * 4 + k];
      }
      out[c * 4 + r] = sum;
    }
  }

  return out;
}

export function translation(x: number, y: number, z: number): Mat4d {
  return Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/** Rotation about XR +Y (the vertical) — positive turns −Z towards −X. */
export function rotationY(angle: number): Mat4d {
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  return Float64Array.from([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

/** Rotation about world +Z (the vertical) — positive turns +X towards +Y. */
function rotationZ(angle: number): Mat4d {
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  return Float64Array.from([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/** Inverse of a rotation + translation (no scale). */
export function rigidInverse(m: Mat4d): Mat4d {
  const out = new Float64Array(16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[c * 4 + r] = m[r * 4 + c];
    }
  }
  for (let r = 0; r < 3; r++) {
    out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]);
  }
  out[15] = 1;

  return out;
}

export function transformPoint(m: Mat4d, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

export function transformDir(m: Mat4d, d: Vec3): Vec3 {
  return [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ];
}

/** A WebXR matrix (f32) as f64. */
export function fromXr(m: ArrayLike<number>): Mat4d {
  return Float64Array.from(m);
}

// -----------------------------------------------------------------------------
// The rig
// -----------------------------------------------------------------------------

/**
 * The starting rig: the XR origin (the head at session start, reference
 * space 'local') lands on the desktop eye, and the XR forward on the desktop
 * forward's heading. Pitch is dropped — the reference space is gravity-
 * aligned, so only the heading carries over.
 */
export function rigFromCamera(eye: Vec3, forward: Vec3): Mat4d {
  const horizontal = Math.hypot(forward[0], forward[1]);
  const heading = horizontal > VERTICAL_EPS ? Math.atan2(forward[1], forward[0]) : 0;

  return multiply(Z_UP_TO_Y_UP, multiply(rotationZ(Math.PI / 2 - heading), translation(-eye[0], -eye[1], -eye[2])));
}

/** Move the user by `delta` (world units): the world shifts the other way. */
export function moveRig(rig: Mat4d, delta: Vec3): Mat4d {
  return multiply(rig, translation(-delta[0], -delta[1], -delta[2]));
}

/** Turn the user by `angle` (positive = to the right) about the vertical
 *  through `pivot` (XR space, normally the head). */
export function turnRig(rig: Mat4d, pivot: Vec3, angle: number): Mat4d {
  const toPivot = translation(pivot[0], 0, pivot[2]);
  const fromPivot = translation(-pivot[0], 0, -pivot[2]);

  return multiply(toPivot, multiply(rotationY(angle), multiply(fromPivot, rig)));
}

/**
 * Restrict an XR pose to its heading + position: the rotation about the
 * vertical that its −Z axis (or, held straight up or down, its +Y axis)
 * points along. This is what grabbing and the align lock follow, so a tilted
 * wrist never tilts the model.
 */
export function yawOnly(pose: Mat4d): Mat4d {
  let fx = -pose[8];
  let fz = -pose[10];
  if (Math.hypot(fx, fz) < VERTICAL_EPS) {
    fx = pose[4];
    fz = pose[6];
  }
  const yaw = Math.atan2(-fx, -fz);

  return multiply(translation(pose[12], pose[13], pose[14]), rotationY(yaw));
}

/**
 * The model rides rigidly (heading + position) with a pose: while a grip or
 * the align lock is held, the rig is the grab-time rig carried along by how
 * far the pose has moved since — `rig = Y(pose) · Y(pose0)⁻¹ · rig0`.
 */
export function followPose(rig0: Mat4d, pose0: Mat4d, pose: Mat4d): Mat4d {
  return multiply(yawOnly(pose), multiply(rigidInverse(yawOnly(pose0)), rig0));
}

/** An XR pose (head, controller) in world terms. */
export function worldPose(rig: Mat4d, pose: Mat4d): WorldPose {
  const world = multiply(rigidInverse(rig), pose);

  return { eye: [world[12], world[13], world[14]], forward: [-world[8], -world[9], -world[10]] };
}

/** An XR pose's −Z ray, expressed in another frame (`into` maps XR → it). */
export function poseRay(into: Mat4d, pose: Mat4d): Ray3 {
  const m = multiply(into, pose);

  return { origin: [m[12], m[13], m[14]], dir: [-m[8], -m[9], -m[10]] };
}

// -----------------------------------------------------------------------------
// Eye camera
// -----------------------------------------------------------------------------

/**
 * One headset eye as the renderer's ViewCamera. `viewXr` is the eye's view
 * matrix in XR space (`view.transform.inverse.matrix`) and `projXr` its
 * projection. The projection is rebuilt in the renderer's own form —
 * reversed-Z, infinite far — from the headset's x/y terms, which keep the
 * eye's off-centre frustum (p[8], p[9]). The view math stays f64 until the
 * camera-relative matrices are formed, like the desktop camera.
 */
export function eyeCamera(
  viewXr: ArrayLike<number>,
  projXr: ArrayLike<number>,
  rig: Mat4d,
  near: number,
  width: number,
  height: number,
): ViewCamera {
  const view = multiply(fromXr(viewXr), rig);
  const camToWorld = rigidInverse(view);
  const eye: Vec3 = [camToWorld[12], camToWorld[13], camToWorld[14]];
  const forward: Vec3 = [-camToWorld[8], -camToWorld[9], -camToWorld[10]];
  const origin: Vec3 = [Math.round(eye[0]), Math.round(eye[1]), Math.round(eye[2])];
  const viewRel = multiply(view, translation(origin[0], origin[1], origin[2]));
  const proj = new Float64Array(16);
  proj[0] = projXr[0];
  proj[5] = projXr[5];
  proj[8] = projXr[8];
  proj[9] = projXr[9];
  proj[11] = -1;
  proj[14] = near;

  return {
    width,
    height,
    view: Float32Array.from(view),
    viewProj: Float32Array.from(multiply(proj, view)),
    viewProjRel: Float32Array.from(multiply(proj, viewRel)),
    origin,
    eye,
    forward,
    p00: proj[0],
    p11: proj[5],
    p20: proj[8],
    p21: proj[9],
    near,
    ortho: false,
    orthoNear: 0,
    orthoFar: 0,
    orthoHalfH: 0,
    focusDist: 1,
  };
}

/** Heading + position of a pose as an XRRigidTransform's parts (for an anchor). */
export function poseParts(pose: Mat4d): Readonly<{ position: DOMPointInit; orientation: DOMPointInit }> {
  const yaw = Math.atan2(pose[8], pose[10]);

  return {
    position: { x: pose[12], y: pose[13], z: pose[14], w: 1 },
    orientation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  };
}
