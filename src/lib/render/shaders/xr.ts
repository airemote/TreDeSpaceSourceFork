// Headset-only passes (src/lib/render/xrPasses.ts): the controller ray march,
// the depth hand-off to the XR compositor, and the desktop mirror blit.

/** Rays one ray-pick dispatch marches (one per controller). */
export const XR_RAY_COUNT = 2;

const FULLSCREEN_VS = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VsOut;
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}
`;

/**
 * Controller ray pick: march each ray (eye space of the last rendered eye)
 * against that eye's depth buffer and report the first surface it passes
 * behind, with the item id there. Screen-space: the controller sits close to
 * the eye, so what the ray hits is almost always what the eye sees — a hit
 * hidden from the eye is missed, which is what a reticle drawn on that eye's
 * image would show anyway. Steps grow geometrically (fine near, coarse far),
 * then a bisection pins the crossing.
 */
export function xrRayPickWgsl(msaa: boolean): string {
  return /* wgsl */ `
struct Ray {
  origin: vec4f, // xyz eye-space origin, w = 1 active
  dir: vec4f,    // xyz eye-space unit direction, w = max distance
};
struct RayParams {
  rays: array<Ray, ${XR_RAY_COUNT}>,
  proj: vec4f, // p00, p11, p20, p21
  near: vec4f, // x = near plane (reversed-Z infinite: depth = near / z)
};

@group(0) @binding(0) var depth_tex: ${msaa ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@group(0) @binding(1) var id_tex: ${msaa ? 'texture_multisampled_2d<f32>' : 'texture_2d<f32>'};
@group(0) @binding(2) var<uniform> rp: RayParams;
@group(0) @binding(3) var<storage, read_write> hits: array<vec4u, ${XR_RAY_COUNT}>;

const STEPS = 768u;
const REFINE = 12u;
const FIRST_STEP = 0.02;

fn to_pixel(p: vec3f, dims: vec2f) -> vec2f {
  let z = -p.z;
  let ndc = vec2f(rp.proj.x * p.x / z - rp.proj.z, rp.proj.y * p.y / z - rp.proj.w);
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * dims;
}

// 1 = behind the visible surface, -1 = in front of it (or over background),
// 0 = cannot tell (behind the near plane or off screen)
fn side(p: vec3f, dims: vec2f) -> i32 {
  let z = -p.z;
  if (z <= rp.near.x) { return 0; }
  let q = to_pixel(p, dims);
  if (q.x < 0.0 || q.y < 0.0 || q.x >= dims.x || q.y >= dims.y) { return 0; }
  let d = textureLoad(depth_tex, vec2i(q), 0);
  if (d <= 0.0) { return -1; }
  return select(-1, 1, z >= rp.near.x / d);
}

fn read_id(px: vec2i) -> u32 {
${
  msaa
    ? `  var best = -1.0;
  var v = vec4f(0.0);
  for (var s = 0; s < i32(textureNumSamples(id_tex)); s++) {
    let d = textureLoad(depth_tex, px, s);
    if (d > best) {
      best = d;
      v = textureLoad(id_tex, px, s);
    }
  }`
    : '  let v = textureLoad(id_tex, px, 0);'
}
  let b = vec4u(round(v * 255.0));
  return b.x | (b.y << 8u) | (b.z << 16u) | (b.w << 24u);
}

@compute @workgroup_size(${XR_RAY_COUNT})
fn main(@builtin(local_invocation_index) i: u32) {
  hits[i] = vec4u(0u);
  let ray = rp.rays[i];
  if (ray.origin.w == 0.0) { return; }
  let dims = vec2f(textureDimensions(depth_tex));
  let o = ray.origin.xyz;
  let dir = ray.dir.xyz;
  let growth = pow(max(ray.dir.w / FIRST_STEP, 1.0001), 1.0 / f32(STEPS));
  var prev_t = 0.0;
  var t = FIRST_STEP;
  var seen_front = false;
  for (var k = 0u; k < STEPS; k++) {
    let sd = side(o + dir * t, dims);
    if (sd < 0) {
      seen_front = true;
    } else if (sd > 0 && seen_front) {
      var lo = prev_t;
      var hi = t;
      for (var r = 0u; r < REFINE; r++) {
        let mid = 0.5 * (lo + hi);
        if (side(o + dir * mid, dims) > 0) { hi = mid; } else { lo = mid; }
      }
      let px = vec2i(clamp(to_pixel(o + dir * hi, dims), vec2f(0.0), dims - 1.0));
      hits[i] = vec4u(read_id(px), bitcast<u32>(hi), 1u, 0u);
      return;
    }
    prev_t = t;
    t *= growth;
  }
}
`;
}

/**
 * Depth hand-off: the renderer's reversed-Z infinite depth (depth = near / z)
 * re-expressed in the headset projection's own depth convention
 * (ndc = (p10 * zv + p14) / -zv), so the compositor can reproject with it.
 * Background goes to that projection's far limit.
 */
export function xrDepthWgsl(msaa: boolean): string {
  return /* wgsl */ `
${FULLSCREEN_VS}
struct DepthParams {
  p10: f32,
  p14: f32,
  near: f32,
  _pad: f32,
};

@group(0) @binding(0) var src: ${msaa ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@group(0) @binding(1) var<uniform> dp: DepthParams;

@fragment
fn fs(in: VsOut) -> @builtin(frag_depth) f32 {
  let d = textureLoad(src, vec2i(in.pos.xy), 0);
  if (d <= 0.0) {
    return clamp(-dp.p10, 0.0, 1.0);
  }
  let zv = -dp.near / d;
  return clamp((dp.p10 * zv + dp.p14) / -zv, 0.0, 1.0);
}
`;
}

/** Desktop mirror: one eye's finished image, letterboxed into the canvas. */
export function xrMirrorWgsl(): string {
  return /* wgsl */ `
${FULLSCREEN_VS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(src, samp, in.uv, 0.0).rgb, 1.0);
}
`;
}
