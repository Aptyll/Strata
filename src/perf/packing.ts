/**
 * Packed particle format: 8 bytes per particle.
 *
 *   word 0  position  x:u16 | y:u16 << 16   unorm over the plane's [0, 1) square
 *   word 1  velocity  x:i16 | y:i16 << 16   snorm, scaled by the plane's velMax
 *
 * Why fixed point and not f16: a plane is a bounded 2D square, so fixed point
 * spends all 16 bits on uniform resolution (1/65536 of the plane, far below a
 * pixel) where f16 would waste bits on exponent and lose precision away from
 * the origin. u16 addition also wraps for free, which gives toroidal planes
 * with no branch. Sub-quantum motion is preserved on average by dithered
 * (stochastic) rounding in the shader.
 *
 * The CPU helpers here mirror the WGSL in shaders.ts. They are used for tests
 * and debugging; the hot path never touches particles on the CPU.
 */

export const BYTES_PER_PARTICLE = 8;
export const POS_QUANT = 65536;
export const VEL_QUANT = 32767;

export function packPosition(x: number, y: number): number {
  const xi = Math.floor(x * POS_QUANT) & 0xffff;
  const yi = Math.floor(y * POS_QUANT) & 0xffff;
  return (xi | (yi << 16)) >>> 0;
}

export function unpackPosition(word: number): [number, number] {
  return [(word & 0xffff) / POS_QUANT, (word >>> 16) / POS_QUANT];
}

export function packVelocity(vx: number, vy: number, velMax: number): number {
  const q = (v: number) => Math.max(-VEL_QUANT, Math.min(VEL_QUANT, Math.round((v / velMax) * VEL_QUANT))) & 0xffff;
  return (q(vx) | (q(vy) << 16)) >>> 0;
}

export function unpackVelocity(word: number, velMax: number): [number, number] {
  const s = (u: number) => ((u << 16) >> 16) / VEL_QUANT;
  return [s(word & 0xffff) * velMax, s(word >>> 16) * velMax];
}
