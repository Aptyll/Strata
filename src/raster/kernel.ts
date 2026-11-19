/**
 * WGSL for the app's compute rasterizer, the "atomic-raster" pass
 * (./pass.ts). It projects each particle and adds its light into one u32 per
 * pixel with atomicAdd, in LIGHT_ONE fixed point, and a single fullscreen draw
 * then adds that grid to the HDR target. Nothing blends per particle, so a
 * dense pixel keeps counting long after an rgba16float blend target would
 * stop (about 2048 adds, docs/render.md).
 *
 * rasterKernelWgsl() builds one of four variants:
 *
 *   {}                  one rounded add per particle. This is the default, and
 *                       its text is the kernel the pass has run since PR #8,
 *                       byte for byte, so the default costs nothing new.
 *   { subpixel: true }  the light is split over the 2x2 pixels around the true
 *                       position with bilinear weights (as src/render/splat.ts
 *                       does), so motion stays smooth below one pixel.
 *   { depth: true }     depth cues from src/depth as per-particle terms: fog,
 *                       near fade and size gain become a weight
 *                       (depth_point_weight), and depth of field moves each
 *                       particle to a point inside its circle of confusion
 *                       (depth_lens_jitter_ndc). The point is stable per
 *                       particle, not per frame, so out-of-focus sheets look
 *                       spread out without shimmering.
 *   both                depth cues with the sub-pixel split.
 *
 * The weighted variants round with a hash (stochastic rounding): a fraction f
 * of a unit becomes one unit with probability f, so dim light (far, fogged or
 * split four ways) survives on average instead of truncating to zero.
 *
 * Bindings: group(0) Globals, group(1) the plane (engine `planeSim` layout),
 * group(2) binding 0 the grid size, binding 1 the u32 light grid (row major,
 * top row first), and for depth only, binding 2 DepthParams (src/depth) and
 * binding 3 RasterView (eye position).
 */

import { depthWGSL } from '../depth/depth.wgsl';
import { DISPATCH_ROW_PARTICLES, GLOBALS_WGSL, PARTICLE_WGSL, PLANE_STRUCT_WGSL, WORKGROUP_SIZE } from '../gpu/shaderLib';
import { FULLSCREEN_VS_WGSL, PCG_WGSL, U01_WGSL } from '../gpu/wgsl';
import { LIGHT_ONE } from '../perf/shaders';

export interface RasterKernelOptions {
  /** Split each particle's light over the 2x2 pixels around its true position. */
  subpixel?: boolean;
  /** Fog, near fade, size gain and depth of field from src/depth. */
  depth?: boolean;
}

/** Bytes of the RasterView uniform (eye: vec3f plus padding). */
export const RASTER_VIEW_BYTES = 16;

/** Shared head: declarations, bindings and the first lines of main(). `decls` and `fns` are empty for the default. */
const head = (decls: string, fns: string): string => /* wgsl */ `${GLOBALS_WGSL}
${PLANE_STRUCT_WGSL}
${PARTICLE_WGSL}
struct Size { width: u32, height: u32 }
${decls}
@group(1) @binding(0) var<uniform> plane: Plane;
@group(1) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(2) @binding(0) var<uniform> size: Size;
@group(2) @binding(1) var<storage, read_write> counts: array<atomic<u32>>;
${fns}
@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ${DISPATCH_ROW_PARTICLES}u;
  if (i >= plane.count) { return; }
`;

/** The default body: one add of the plane's light, rounded once per plane. */
const POINT_BODY = /* wgsl */ `  let light = u32(clamp(plane.brightness, 0.0, 16.0) * ${LIGHT_ONE}.0 + 0.5);
  if (light == 0u) { return; }
  let pos = particles[i].pos;
  let clip = globals.viewProj * (plane.model * vec4f(pos, 0.0, 1.0));
  if (clip.w <= 0.0) { return; }
  let ndc = clip.xyz / clip.w;
  if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0 || ndc.z < 0.0 || ndc.z > 1.0) { return; }
  let px = vec2u((ndc.xy * vec2f(0.5, -0.5) + 0.5) * vec2f(f32(size.width), f32(size.height)));
  if (px.x >= size.width || px.y >= size.height) { return; }
  atomicAdd(&counts[px.y * size.width + px.x], light);
}
`;

const DEPTH_DECLS = /* wgsl */ `${depthWGSL}
struct RasterView { eye: vec3f, pad: f32 }
@group(2) @binding(2) var<uniform> dp: DepthParams;
@group(2) @binding(3) var<uniform> rasterView: RasterView;
`;

const DEPOSIT_FN = /* wgsl */ `${PCG_WGSL}${U01_WGSL}
// Adds v fixed-point units to one pixel, rounded with the hash h.
fn deposit(x: i32, y: i32, v: f32, h: u32) {
  if (x < 0 || y < 0 || x >= i32(size.width) || y >= i32(size.height)) { return; }
  let q = u32(v + u01(h));
  if (q == 0u) { return; }
  atomicAdd(&counts[u32(y) * size.width + u32(x)], q);
}
`;

/** Body of the weighted variants: float light, optional depth cues, point or 2x2 deposit. */
const weightedBody = (subpixel: boolean, depth: boolean): string => /* wgsl */ `  var light = clamp(plane.brightness, 0.0, 16.0) * ${LIGHT_ONE}.0;
  if (light <= 0.0) { return; }
  let pos = particles[i].pos;
  let world = plane.model * vec4f(pos, 0.0, 1.0);
  var clip = globals.viewProj * world;
  if (clip.w <= 0.0) { return; }
  let viewport = vec2f(f32(size.width), f32(size.height));
  let id = pcg(i ^ pcg(bitcast<u32>(plane.seed)));
  var h = pcg(id ^ (globals.frame * 0x9E3779B9u));
${
  depth
    ? /* wgsl */ `  // Depth cues. clip.w is the distance along the view axis. The lens sample
  // hashes the particle id only, so each particle keeps its place in the blur.
  light *= depth_point_weight(clip.w, distance(world.xyz, rasterView.eye), dp);
  let lens = pcg(id ^ 0x6C8E9CF5u);
  let jitter = depth_lens_jitter_ndc(clip.w, vec2f(u01(lens), u01(pcg(lens))), viewport, dp);
  clip = vec4f(clip.xy + jitter * clip.w, clip.zw);
`
    : ''
}  let ndc = clip.xyz / clip.w;
  if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0 || ndc.z < 0.0 || ndc.z > 1.0) { return; }
${
  subpixel
    ? /* wgsl */ `  let p = (ndc.xy * vec2f(0.5, -0.5) + 0.5) * viewport - 0.5;
  let f0 = floor(p);
  let fr = p - f0;
  let ix = i32(f0.x);
  let iy = i32(f0.y);
  deposit(ix, iy, light * (1.0 - fr.x) * (1.0 - fr.y), h);
  h = pcg(h);
  deposit(ix + 1, iy, light * fr.x * (1.0 - fr.y), h);
  h = pcg(h);
  deposit(ix, iy + 1, light * (1.0 - fr.x) * fr.y, h);
  h = pcg(h);
  deposit(ix + 1, iy + 1, light * fr.x * fr.y, h);
`
    : /* wgsl */ `  let px = vec2i((ndc.xy * vec2f(0.5, -0.5) + 0.5) * viewport);
  deposit(px.x, px.y, light, h);
`
}}
`;

/** The compute kernel for one combination of options. With none, it is RASTER_KERNEL_WGSL. */
export function rasterKernelWgsl(options: RasterKernelOptions = {}): string {
  const subpixel = options.subpixel === true;
  const depth = options.depth === true;
  if (!subpixel && !depth) return head('', '') + POINT_BODY;
  return head(depth ? DEPTH_DECLS : '', DEPOSIT_FN) + weightedBody(subpixel, depth);
}

/** The default kernel: one add per particle, no cues. Exported as ATOMIC_RASTER_WGSL by src/perf. */
export const RASTER_KERNEL_WGSL = rasterKernelWgsl();

/** Adds the light grid to the HDR target, scaled by globals.brightness. */
export const RASTER_COMPOSITE_WGSL = /* wgsl */ `${GLOBALS_WGSL}
struct Size { width: u32, height: u32 }
@group(1) @binding(0) var<uniform> size: Size;
@group(1) @binding(1) var<storage, read> counts: array<u32>;
${FULLSCREEN_VS_WGSL}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let x = min(u32(pos.x), size.width - 1u);
  let y = min(u32(pos.y), size.height - 1u);
  let v = f32(counts[y * size.width + x]) * (globals.brightness / ${LIGHT_ONE}.0);
  return vec4f(v, v, v, 1.0);
}
`;
