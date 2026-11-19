// Shared WGSL snippets, constants and small helpers for src/render.
//
// WGSL has no imports, so shaders here are assembled by concatenating these
// strings. Each snippet declares its own names (VSOut, vs, pcg, u01, Tone,
// densityToLuma, CounterLayout, loadCount); include each at most once per
// shader module.

/** Fullscreen triangle. uv has its origin at the top left, like texture space. */
export const FULLSCREEN_VS = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var o: VSOut;
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;

/** PCG hash, used for dithering and stochastic rounding. */
export const HASH_WGSL = /* wgsl */ `
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn u01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
`;

/**
 * Largest density, as a WGSL literal, that the post chain trusts from a float
 * texture. Every stage that reads density clamps to [0, DENSITY_MAX], which
 * keeps inf and NaN out of trails, bloom and the tone curve.
 */
export const DENSITY_MAX = '1.0e30';

/** Byte size of the Tone uniform below (12 four-byte fields). */
export const TONE_UNIFORM_BYTES = 48;

/**
 * Tone parameters, one uniform shared by the bloom prefilter and the final
 * composite so both use the same curve. Written by ToneMap.write() in
 * tonemap.ts; the byte offsets there must match this struct.
 */
export const TONE_WGSL = /* wgsl */ `
struct Tone {
  exposure: f32,        //  0  multiplies raw density
  white: f32,           //  4  exposed density that maps to luma 1.0
  curve: u32,           //  8  0 log, 1 power, 2 linear
  display: u32,         // 12  0 soft shoulder, 1 filmic, 2 hard clip
  power: f32,           // 16  exponent for the power curve
  bloomStrength: f32,   // 20  already divided by the number of bloom levels
  bloomThreshold: f32,  // 24  luma below this does not bloom
  dither: f32,          // 28  amplitude in 8-bit steps
  frame: u32,           // 32  frame counter, seeds the dither
  encodeSrgb: u32,      // 36  1 when the target is not an -srgb format
  contrast: f32,        // 40  exponent applied to luma after the curve
  pad1: u32,            // 44
};

const DENSITY_MAX = ${DENSITY_MAX};

// Density (sum of particle energy that landed on a pixel) to scene luma.
// The result may exceed 1.0 above the white point; the display curve handles that.
fn densityToLuma(density: f32, t: Tone) -> f32 {
  let e = clamp(density, 0.0, DENSITY_MAX) * t.exposure;
  let w = max(t.white, 1.0e-6);
  var l: f32;
  switch t.curve {
    case 0u { l = log(1.0 + e) / log(1.0 + w); }
    case 1u { l = pow(e / w, t.power); }
    default { l = e / w; }
  }
  return pow(max(l, 0.0), t.contrast);
}
`;

export const CURVES = { log: 0, power: 1, linear: 2 } as const;
export const DISPLAYS = { soft: 0, filmic: 1, clip: 2 } as const;
export type Curve = keyof typeof CURVES;
export type Display = keyof typeof DISPLAYS;

/** one + one blending: every fragment adds its light to what is already there. */
export const ADDITIVE_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

/** Float formats usable for the density buffer on this device. */
export function pickHdrFormat(device: GPUDevice): GPUTextureFormat {
  // r32float keeps exact counts into the millions per pixel, but additive
  // blending into it needs an optional feature. r16float always works and
  // stops gaining precision at about 2048 units of energy per pixel.
  return device.features.has('float32-blendable') ? 'r32float' : 'r16float';
}

// ---- integer counters -> density ------------------------------------------
//
// Compute rasterizers add fixed point energy into a buffer of unsigned
// integers with atomicAdd, one counter per pixel. Two layouts:
//
//   words = 1   array<u32>, counter i at word i
//   words = 2   64 bit, low word first: counter i at words 2i (lo), 2i+1 (hi)
//
// Pixels are row major, top row first: i = offset + y * stride + x.
// SplatAccumulator ('compute' mode) and CountToneMapper both resolve their
// counters to a float density texture with the shader below.

/** Byte size of the CounterLayout uniform (5 four-byte fields, padded to 32). */
export const COUNTER_LAYOUT_BYTES = 32;

/** CounterLayout uniform at binding 0, counters at binding 1, and `loadCount`. */
export const counterLoadWgsl = (words: 1 | 2): string => /* wgsl */ `
struct CounterLayout {
  width: u32,
  height: u32,
  stride: u32,     // counters per row in the buffer
  offset: u32,     // index of the first counter
  invScale: f32,   // 1 / (counter units per unit of energy)
};
@group(0) @binding(0) var<uniform> lay: CounterLayout;
@group(0) @binding(1) var<storage, read> counters: array<u32>;

fn loadCount(x: u32, y: u32) -> f32 {
  let i = lay.offset + y * lay.stride + x;
  ${words === 2
    ? 'return f32(counters[2u * i]) + f32(counters[2u * i + 1u]) * 4294967296.0;'
    : 'return f32(counters[i]);'}
}
`;

/**
 * Fullscreen pass that writes `count * invScale` into the red channel of the
 * target, one pixel per counter. Entry points `vs` and `fs`.
 */
export const counterResolveWgsl = (words: 1 | 2): string => FULLSCREEN_VS + counterLoadWgsl(words) + /* wgsl */ `
@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let c = vec2u(i.pos.xy);
  return vec4f(loadCount(c.x, c.y) * lay.invScale, 0.0, 0.0, 1.0);
}
`;

/** Pack the CounterLayout uniform. `stride` 0 means `width`. */
export function packCounterLayout(width: number, height: number, invScale: number, stride = 0, offset = 0): ArrayBuffer {
  const b = new ArrayBuffer(COUNTER_LAYOUT_BYTES);
  const u = new Uint32Array(b);
  u[0] = width;
  u[1] = height;
  u[2] = stride || width;
  u[3] = offset;
  new Float32Array(b)[4] = invScale;
  return b;
}
