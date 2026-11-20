// One rendered view's camera, as the scene passes consume it. The desktop
// frame builds it from the CameraController; a headset frame builds one per
// eye from the XR view pose (src/lib/xr/xrMath.ts). Everything the cull,
// scene, post and AO uniforms take from "the camera" goes through here, so
// the same pass sequence renders either.

export type Vec3 = readonly [number, number, number];

export type ViewCamera = Readonly<{
  /** Target size in device pixels (canvas, or one eye's layer viewport). */
  width: number;
  height: number;
  /** Absolute world view matrix, column-major — the cull pass works in world space. */
  view: Float32Array;
  /** Absolute view-projection; the cull's frustum planes come from it. */
  viewProj: Float32Array;
  /** The view-projection rebased on `origin` (camera-relative rendering). */
  viewProjRel: Float32Array;
  /** The per-frame rebase origin (the eye, rounded to whole units). */
  origin: Vec3;
  eye: Vec3;
  forward: Vec3;
  /** Projection scale terms p[0], p[5], and the off-centre terms p[8], p[9]:
   *  zero for the desktop's symmetric frustum, non-zero for a headset eye. */
  p00: number;
  p11: number;
  p20: number;
  p21: number;
  near: number;
  ortho: boolean;
  orthoNear: number;
  orthoFar: number;
  orthoHalfH: number;
  /** Camera → target distance (ortho edge-fade floor). */
  focusDist: number;
}>;
