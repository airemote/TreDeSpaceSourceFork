// Headset pose math: the world (Z-up) ↔ XR (Y-up) rig, locomotion on it, the
// grab/align follow, and the per-eye camera the renderer gets.
import { describe, expect, it } from 'vitest';
import {
  eyeCamera,
  followPose,
  fromXr,
  type Mat4d,
  moveRig,
  poseParts,
  poseRay,
  rigFromCamera,
  rotationY,
  translation,
  turnRig,
  worldPose,
  yawOnly,
} from '../src/lib/xr/xrMath';

const IDENTITY = translation(0, 0, 0);

function expectVec(actual: readonly number[], expected: readonly number[]): void {
  expected.forEach((v, i) => {
    expect(actual[i]).toBeCloseTo(v, 6);
  });
}

describe('rig from the desktop camera', () => {
  it('puts the XR head on the desktop eye, looking along its heading', () => {
    const rig = rigFromCamera([10, 20, 3], [1, 0, 0]);
    const head = worldPose(rig, IDENTITY);
    expectVec(head.eye, [10, 20, 3]);
    expectVec(head.forward, [1, 0, 0]);
  });

  it('drops the pitch (the reference space is gravity-aligned)', () => {
    const rig = rigFromCamera([0, 0, 0], [0, 0.6, -0.8]);
    expectVec(worldPose(rig, IDENTITY).forward, [0, 1, 0]);
  });

  it('maps world up to XR up', () => {
    const rig = rigFromCamera([0, 0, 0], [1, 0, 0]);
    const lookUp = rotationX(Math.PI / 2); // head pitched up 90°
    expectVec(worldPose(rig, lookUp).forward, [0, 0, 1]);
  });
});

describe('locomotion on the rig', () => {
  it('moves the user by a world delta', () => {
    const rig = moveRig(rigFromCamera([1, 2, 3], [1, 0, 0]), [5, 0, -1]);
    expectVec(worldPose(rig, IDENTITY).eye, [6, 2, 2]);
  });

  it('turns right about the head', () => {
    const rig = rigFromCamera([4, 4, 1], [1, 0, 0]);
    const turned = turnRig(rig, [0, 0, 0], Math.PI / 2);
    const head = worldPose(turned, IDENTITY);
    expectVec(head.forward, [0, -1, 0]); // right of +X in a Z-up world
    expectVec(head.eye, [4, 4, 1]); // turning in place
  });
});

describe('grab / align follow', () => {
  it('carries the model with the hand, heading and position only', () => {
    const rig0 = rigFromCamera([0, 0, 0], [0, 1, 0]);
    const pose0 = translation(0, 1, -0.5);
    // hand moved 1 m to the right and tilted — the tilt must not reach the model
    const pose = multiplyAll(translation(1, 1, -0.5), rotationX(0.4));
    const rig = followPose(rig0, pose0, pose);
    const worldPoint: [number, number, number] = [0, 3, 0];
    const before = apply(rig0, worldPoint);
    const after = apply(rig, worldPoint);
    expectVec(after, [before[0] + 1, before[1], before[2]]);
  });

  it('turns the model with the hand heading', () => {
    const pose = rotationY(Math.PI / 2);
    const yaw = yawOnly(pose);
    expectVec(Array.from(yaw), Array.from(pose));
    const parts = poseParts(yaw);
    expect(parts.orientation.y).toBeCloseTo(Math.sin(Math.PI / 4), 6);
  });
});

describe('eye camera', () => {
  it('keeps the off-centre terms and builds a reversed-Z projection', () => {
    const proj = new Float32Array(16);
    proj[0] = 0.9;
    proj[5] = 0.8;
    proj[8] = 0.1;
    proj[9] = -0.05;
    proj[11] = -1;
    const rig = rigFromCamera([100, 200, 2], [1, 0, 0]);
    const cam = eyeCamera(IDENTITY, proj, rig, 0.05, 1600, 1700);
    expect(cam.p20).toBeCloseTo(0.1);
    expect(cam.p21).toBeCloseTo(-0.05);
    expectVec(cam.eye, [100, 200, 2]);
    expectVec(cam.origin, [100, 200, 2]);
    // a point 10 m ahead: in front (w > 0), reversed-Z depth = near / 10
    const clip = mulVec(cam.viewProj, [110, 200, 2, 1]);
    expect(clip[3]).toBeCloseTo(10, 4);
    expect(clip[2] / clip[3]).toBeCloseTo(0.005, 5);
    // the camera-relative matrix agrees once the origin is subtracted (to f32
    // precision of the ABSOLUTE matrix — the reason the relative one exists)
    const rel = mulVec(cam.viewProjRel, [10, 0, 0, 1]);
    rel.forEach((v, i) => {
      expect(v).toBeCloseTo(clip[i], 4);
    });
  });

  it('expresses a controller ray in an eye frame', () => {
    const ray = poseRay(translation(0, 0, -1), translation(0.2, -0.3, 0));
    expectVec(ray.origin, [0.2, -0.3, -1]);
    expectVec(ray.dir, [0, 0, -1]);
  });

  it('reads WebXR matrices as f64', () => {
    expect(fromXr(new Float32Array(16).fill(1))).toBeInstanceOf(Float64Array);
  });
});

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function rotationX(angle: number): Mat4d {
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  return Float64Array.from([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function multiplyAll(a: Mat4d, b: Mat4d): Mat4d {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) {
        out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
      }
    }
  }

  return out;
}

function apply(m: Mat4d, p: readonly [number, number, number]): number[] {
  return mulVec(m, [...p, 1]).slice(0, 3);
}

function mulVec(m: ArrayLike<number>, v: readonly number[]): number[] {
  return [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
}
