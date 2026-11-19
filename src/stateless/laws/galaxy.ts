import { TAU, u01 } from '../rng';
import { clamp, defineLaw, fract } from './types';

/**
 * Galaxy: a density-wave spiral.
 *
 * Stars sit on nested rings. Each ring is bent into `arms` lobes, and the
 * orientation of the lobes winds with radius as a log spiral and turns slowly
 * at the pattern speed. Where neighbouring rings crowd together the density
 * piles up into arms, so the arms are a wave the stars stream through, not
 * material that winds up: inner stars overtake the arms, outer stars fall
 * behind, and the pattern holds for as long as the clip runs.
 *
 * q.x walks along a ring (one eighth of a turn, so it stays compact), q.y is
 * the radius, q.z picks the population (bulge, clumps, disk) and, inside the
 * band, the sector and a small epicycle phase that softens the arms. Clumps
 * are star clusters: groups of particles sharing one orbit, which shear into
 * short arcs as they go round.
 */
export const galaxy = defineLaw({
  id: 'galaxy',
  title: 'Galaxy',
  summary:
    'A grand-design spiral. Arms are a density wave: stars on bent rings crowd where the rings meet, ' +
    'and stream through the arms at their own speed, faster near the centre.',
  qFn: 'lawGalaxyQ',
  params: [
    { name: 'arms', default: 2, min: 1, max: 4, integer: true, note: 'number of spiral arms' },
    { name: 'winding', default: 2.4, min: 0, max: 6, note: 'how tightly the arms wind (log spiral)' },
    { name: 'eccentricity', default: 0.3, min: 0, max: 0.5, note: 'arm contrast: how far rings bend' },
    { name: 'spin', default: 0.25, min: 0, max: 1, note: 'orbital speed, radians per second near the middle' },
    { name: 'pattern', default: 0.35, min: -0.5, max: 1, note: 'arm pattern speed as a fraction of spin' },
    { name: 'bulge', default: 0.14, min: 0, max: 0.5, note: 'fraction of particles in the central bulge' },
    { name: 'clumps', default: 0.05, min: 0, max: 0.2, note: 'fraction of particles in star clusters' },
    { name: 'seed', default: 0, min: 0, max: 1000, note: 'per-sheet variant: orientation and cluster layout' },
  ],
  cost: {
    transcendental: 6,
    fma: 38,
    stretch: 0.8,
    note: 'floor for the slot, log for the radius, log for the spiral, cos for the arms, cos and sin for the orbit',
  },
  // q.z picks the population and the sector, so neighbours in (q.x, q.y) scatter.
  coherent: false,
  wgsl: /* wgsl */ `
// Galaxy. p: [arms, winding, eccentricity, spin, pattern, bulge, clumps, seed]
fn lawGalaxyQ(q: vec3f, t: f32, p: array<f32, 8>) -> vec2f {
  let m = floor(p[0] + 0.5);
  let fb = p[5];
  let fc = p[6];
  // Population from q.z: [0, fb) bulge, [fb, fb + fc) clumps, the rest disk.
  let isBulge = q.z < fb;
  let isClump = !isBulge && q.z < fb + fc;
  let lo = select(select(fb + fc, fb, isClump), 0.0, isBulge);
  // Slots inside the band: a sector (disk, bulge) or a cluster id (clumps).
  let ss = (q.z - lo) * 2048.0;
  let slot = floor(ss);
  let su = u32(slot);
  // Epicycle phase for disk and bulge stars; clusters keep theirs tight.
  let sc = select(2.0 * (ss - slot) - 1.0, 0.0, isClump);
  let cx = 2.0 * q.x - 1.0;
  let cy = 2.0 * q.y - 1.0;
  // Guiding radius. Disk: exponential profile, so the rim fades out.
  let rDisk = 0.02 - 0.19 * log(1.0 - 0.99 * q.y);
  let rBulge = 0.003 + 0.17 * q.y * q.y;
  // Cluster places: the R2 sequence in u32 fixed point, exact on every device.
  let rClump = 0.2 + 0.62 * u01(su * 0x91e10da5u) + 0.003 * cy * cy * cy;
  let r = select(select(rDisk, rClump, isClump), rBulge, isBulge);
  // Starting angle, kept in [0, 2pi) so f32 resolves the small spreads. Disk
  // and bulge: a sector of 1/8 turn walked by q.x. Clusters: their own place
  // plus a small spread.
  let sector = f32(su & 7u);
  let a0 = select((sector + q.x) * 0.7853981634, TAU * u01(su * 0xc13fa9a9u) + 0.015 * cx * cx * cx, isClump);
  // Per-sheet variant: an orientation and a time offset, so clusters start
  // sheared rather than lined up.
  let spin0 = TAU * fract(p[7] * 0.1591549431);
  let tt = t + 12.0 + 6.0 * fract(p[7] * 0.1234567);
  // Differential rotation: angular speed falls with radius.
  let theta = a0 + spin0 + p[3] * (2.2 - 1.6 * r) * tt;
  // Lobe orientation: a log spiral turning at the pattern speed.
  let alpha = p[1] * log(r) + p[4] * p[3] * tt + 2.0 * spin0;
  let e = select(p[2] * clamp(6.0 * r, 0.0, 1.0) * clamp(2.0 - 2.0 * r, 0.0, 1.0), 0.0, isBulge);
  // The epicycle phase (sc) softens the arms and blurs the rim outward.
  let rho = 0.97 * r * (1.0 + e * cos(m * (theta - alpha) + 0.7 * sc)) + 0.05 * r * r * r * sc;
  return rho * vec2f(cos(theta), sin(theta));
}
`,
  mirror(q, t, p) {
    // The discrete choices (band, slot) are made in f32, as on the GPU, so the
    // mirror picks the same slot on boundaries.
    const f32 = Math.fround;
    const m = Math.floor(p[0] + 0.5);
    const fb = f32(p[5]);
    const fc = f32(p[6]);
    const isBulge = q[2] < fb;
    const isClump = !isBulge && q[2] < f32(fb + fc);
    const lo = isBulge ? 0 : isClump ? fb : f32(fb + fc);
    const ss = f32(f32(q[2] - lo) * 2048);
    const slot = Math.floor(ss);
    const su = slot >>> 0;
    const sc = isClump ? 0 : 2 * (ss - slot) - 1;
    const cx = 2 * q[0] - 1;
    const cy = 2 * q[1] - 1;
    const rDisk = 0.02 - 0.19 * Math.log(1 - 0.99 * q[1]);
    const rBulge = 0.003 + 0.17 * q[1] * q[1];
    const rClump = 0.2 + 0.62 * u01(Math.imul(su, 0x91e10da5) >>> 0) + 0.003 * cy * cy * cy;
    const r = isBulge ? rBulge : isClump ? rClump : rDisk;
    const sector = su & 7;
    const a0 = isClump ? TAU * u01(Math.imul(su, 0xc13fa9a9) >>> 0) + 0.015 * cx * cx * cx : (sector + q[0]) * 0.7853981634;
    const spin0 = TAU * fract(p[7] * 0.1591549431);
    const tt = t + 12 + 6 * fract(p[7] * 0.1234567);
    const theta = a0 + spin0 + p[3] * (2.2 - 1.6 * r) * tt;
    const alpha = p[1] * Math.log(r) + p[4] * p[3] * tt + 2 * spin0;
    const e = isBulge ? 0 : p[2] * clamp(6 * r, 0, 1) * clamp(2 - 2 * r, 0, 1);
    const rho = 0.97 * r * (1 + e * Math.cos(m * (theta - alpha) + 0.7 * sc)) + 0.05 * r * r * r * sc;
    return [rho * Math.cos(theta), rho * Math.sin(theta)];
  },
});
