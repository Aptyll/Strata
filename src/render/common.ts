// Shared WGSL snippets and small helpers for the render pipeline.

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
 * Tone parameters shared by the bloom prefilter and the final composite.
 * Layout must match ToneMap.write() in tonemap.js (48 bytes).
 */
export const TONE_WGSL = /* wgsl */ `
struct Tone {
  exposure: f32,        // multiplies raw density
  white: f32,           // exposed density that maps to luma 1.0
  curve: u32,           // 0 log, 1 power, 2 linear
  display: u32,         // 0 soft shoulder, 1 filmic, 2 hard clip
  power: f32,           // exponent for the power curve
  bloomStrength: f32,
  bloomThreshold: f32,
  dither: f32,          // amplitude in 8-bit steps
  frame: u32,
  encodeSrgb: u32,      // 1 when the target is not an -srgb format
  pad0: u32,
  pad1: u32,
};

// Largest finite value we trust from a float target. Keeps inf out of the chain.
const DENSITY_MAX = 1.0e9;

// Density (sum of particle energy that landed on a pixel) to scene luma.
// The result may exceed 1.0 above the white point; the display curve handles that.
fn densityToLuma(density: f32, t: Tone) -> f32 {
  let e = clamp(density, 0.0, DENSITY_MAX) * t.exposure;
  let w = max(t.white, 1.0e-6);
  switch t.curve {
    case 0u { return log(1.0 + e) / log(1.0 + w); }
    case 1u { return pow(e / w, t.power); }
    default { return e / w; }
  }
}
`;

export const CURVES = { log: 0, power: 1, linear: 2 } as const;
export const DISPLAYS = { soft: 0, filmic: 1, clip: 2 } as const;
export type Curve = keyof typeof CURVES;
export type Display = keyof typeof DISPLAYS;

/** Float formats usable for the density buffer on this device. */
export function pickHdrFormat(device: GPUDevice): GPUTextureFormat {
  // r32float keeps exact counts into the millions per pixel, but additive
  // blending into it needs an optional feature. r16float always works and
  // stops gaining precision at about 2048 units of energy per pixel.
  return device.features.has('float32-blendable') ? 'r32float' : 'r16float';
}
