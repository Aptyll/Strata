// Arrangements: recipes that lay out a group of planes in a unit-sized local
// space (everything fits roughly inside a sphere of radius 1 around the origin,
// with +Y as "up"). The world generator scales, rotates and places them.
//
// Every recipe is a pure function (rng, options) -> LocalPlane[].
// A LocalPlane is { position, rotation, size: [width, height], group }.
// `group` is a small integer naming a family of planes inside the structure
// (one orientation, one tier, one arm). Planes in the same group get the same
// behavior, which is what makes a turn of the camera reveal a new behavior:
// paper seen edge-on disappears, and a different family faces you.

import type { Quat, Vec2, Vec3 } from '../core/contracts';
import { quatFromNormal } from './math';
import type { Rng } from './rng';

/** A plane in a recipe's unit-sized local space. */
export interface LocalPlane {
  position: Vec3;
  rotation: Quat;
  /** Full extents [width, height]. */
  size: Vec2;
  /** Family index inside the structure. One behavior per group. */
  group: number;
}

/** Optional overrides for a recipe. Each recipe documents the keys it reads. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ArrangementParams = Record<string, any>;

export interface Arrangement {
  build(rng: Rng, opts?: ArrangementParams): LocalPlane[];
  /** Default relative frequency in the world. */
  weight: number;
  /** How a structure may be rotated when placed: any rotation, or +Y kept up. */
  orient: 'free' | 'yaw';
}

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

function plane(position: Vec3, normal: Vec3, size: Vec2, group: number, up: Vec3 = Y): LocalPlane {
  return { position, rotation: quatFromNormal(normal, up), size, group };
}

/** Parallel sheets like pages of a book, seen best along the stack axis. */
export function stack(rng: Rng, opts: ArrangementParams = {}): LocalPlane[] {
  const count = opts.count ?? rng.intRange(6, 24);
  const depth = opts.depth ?? rng.range(0.6, 1.4);
  const w = opts.width ?? rng.range(0.7, 1.2);
  const h = opts.height ?? rng.range(0.7, 1.2);
  const taper = opts.taper ?? (rng.chance(0.3) ? rng.range(0.3, 0.8) : 1);
  const groups = opts.groups ?? rng.intRange(1, 3);
  const out: LocalPlane[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const s = 1 + (taper - 1) * t;
    out.push(plane([0, 0, (t - 0.5) * depth], Z, [w * s, h * s], Math.floor(t * groups * 0.999)));
  }
  return out;
}

/** A regular 3D grid of small parallel planes. */
export function lattice(rng: Rng, opts: ArrangementParams = {}): LocalPlane[] {
  const [nx, ny, nz] = opts.counts ?? [rng.intRange(2, 5), rng.intRange(2, 5), rng.intRange(2, 6)];
  const fill = opts.fill ?? rng.range(0.6, 0.95);
  const jitter = opts.jitter ?? (rng.chance(0.4) ? rng.range(0, 0.25) : 0);
  const extent = 1.15;
  const cell = [extent / nx, extent / ny, extent / nz];
  const out: LocalPlane[] = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const p: Vec3 = [
          (ix + 0.5 - nx / 2) * cell[0] + rng.range(-1, 1) * jitter * cell[0],
          (iy + 0.5 - ny / 2) * cell[1] + rng.range(-1, 1) * jitter * cell[1],
          (iz + 0.5 - nz / 2) * cell[2] + rng.range(-1, 1) * jitter * cell[2],
        ];
        out.push(plane(p, Z, [cell[0] * fill, cell[1] * fill], iz % 3));
      }
    }
  }
  return out;
}

/**
 * Three interpenetrating stacks, one per axis. From each axis a different
 * family faces the camera while the other two are edge-on.
 */
export function crossed(rng: Rng, opts: ArrangementParams = {}): LocalPlane[] {
  const count = opts.count ?? rng.intRange(3, 9);
  const size = opts.size ?? 1.1;
  const out: LocalPlane[] = [];
  const axes = [X, Y, Z];
  for (let a = 0; a < 3; a++) {
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count - 0.5;
      const p: Vec3 = [0, 0, 0];
      p[a] = t * size;
      out.push(plane(p, axes[a], [size, size], a, a === 1 ? Z : Y));
    }
  }
  return out;
}

/** Planes climbing a helix, growing as they go. */
export function spiral(rng: Rng, opts: ArrangementParams = {}): LocalPlane[] {
  const count = opts.count ?? rng.intRange(16, 48);
  const turns = opts.turns ?? rng.range(1.5, 5);
  const facing = opts.facing ?? rng.pick(['axis', 'tangent', 'up']);
  const arms = opts.arms ?? rng.intRange(1, 3);
  const r0 = 0.12;
  const r1 = 0.8;
  const out: LocalPlane[] = [];
  for (let arm = 0; arm < arms; arm++) {
    const phase = (arm / arms) * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const angle = phase + t * turns * Math.PI * 2;
      const r = r0 + (r1 - r0) * t;
      const radial: Vec3 = [Math.cos(angle), 0, Math.sin(angle)];
      const tangent: Vec3 = [-Math.sin(angle), 0, Math.cos(angle)];
      const p: Vec3 = [radial[0] * r, (t - 0.5) * 1.3, radial[2] * r];
      const s = 0.08 + 0.34 * t;
      const normal = facing === 'axis' ? radial : facing === 'tangent' ? tangent : Y;
      out.push(plane(p, normal, [s, s * 1.4], arm, facing === 'up' ? radial : Y));
    }
  }
  return out;
}

/** A loose swarm of planes at random angles and sizes. */
export function cloud(rng: Rng, opts: ArrangementParams = {}): LocalPlane[] {
  const count = opts.count ?? rng.intRange(20, 70);
  const groups = opts.groups ?? rng.intRange(2, 4);
  const out: LocalPlane[] = [];
  for (let i = 0; i < count; i++) {
    let p: Vec3 = [rng.gauss() * 0.38, rng.gauss() * 0.38, rng.gauss() * 0.38];
    const l = Math.hypot(p[0], p[1], p[2]);
    if (l > 0.95) p = [(p[0] / l) * 0.95, (p[1] / l) * 0.95, (p[2] / l) * 0.95];
    const s = 0.06 + 0.4 * Math.pow(rng.float(), 2.5);
    out.push({
      position: p,
      rotation: rng.quat(),
      size: [s * rng.range(0.6, 1.6), s],
      group: rng.int(groups),
    });
  }
  return out;
}

/** Planes tiling a sphere, all facing the centre. */
export function shell(rng: Rng, opts: ArrangementParams = {}): LocalPlane[] {
  const count = opts.count ?? rng.intRange(24, 80);
  const radius = opts.radius ?? 0.8;
  const bands = opts.bands ?? 3;
  const fill = opts.fill ?? rng.range(0.6, 1.0);
  const s = Math.sqrt((4 * Math.PI * radius * radius) / count) * fill;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: LocalPlane[] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const a = i * golden;
    const n: Vec3 = [r * Math.cos(a), y, r * Math.sin(a)];
    const band = Math.min(bands - 1, Math.floor(((y + 1) / 2) * bands));
    out.push(plane([n[0] * radius, n[1] * radius, n[2] * radius], n, [s, s], band));
  }
  return out;
}

/** Sheets hinged on a shared vertical edge, like a book fanned open. */
export function fan(rng: Rng, opts: ArrangementParams = {}): LocalPlane[] {
  const count = opts.count ?? rng.intRange(8, 28);
  const sweep = opts.sweep ?? rng.pick([Math.PI, Math.PI * 1.5, Math.PI * 2]);
  const reach = opts.reach ?? 0.85;
  const height = opts.height ?? rng.range(0.6, 1.3);
  const full = sweep >= Math.PI * 2 - 1e-6;
  const out: LocalPlane[] = [];
  for (let i = 0; i < count; i++) {
    const t = full ? i / count : count === 1 ? 0.5 : i / (count - 1);
    const angle = t * sweep;
    const radial: Vec3 = [Math.cos(angle), 0, Math.sin(angle)];
    const tangent: Vec3 = [-Math.sin(angle), 0, Math.cos(angle)];
    out.push(plane([radial[0] * reach * 0.5, 0, radial[2] * reach * 0.5], tangent, [reach, height], i % 2));
  }
  return out;
}

/**
 * A nave built from sheets. Along the nave you see the transverse ribs as a
 * deep stack, from the side you see the arcade walls, from above the floor
 * and the vault tiers, and the end wall carries a "rose window".
 * Groups: 0 floor, 1 arcade walls, 2 ribs, 3 vault tiers, 4 window and spire.
 */
export function cathedral(rng: Rng, opts: ArrangementParams = {}): LocalPlane[] {
  const bays = opts.bays ?? rng.intRange(5, 11);
  const naveLength = 1.6;
  const naveWidth = opts.width ?? rng.range(0.32, 0.5);
  const wallHeight = opts.height ?? rng.range(0.6, 0.9);
  const tiers = opts.tiers ?? rng.intRange(2, 5);
  const aisles = opts.aisles ?? rng.chance(0.6);
  const floorY = -0.5;
  const bay = naveLength / bays;
  const out: LocalPlane[] = [];

  const floorWidth = naveWidth * (aisles ? 2.2 : 1.3);
  out.push(plane([0, floorY, 0], Y, [floorWidth, naveLength], 0, Z));

  for (let i = 0; i < bays; i++) {
    const z = (i + 0.5) * bay - naveLength / 2;
    for (const side of [-1, 1]) {
      out.push(
        plane(
          [side * naveWidth * 0.5, floorY + wallHeight / 2, z],
          [side, 0, 0],
          [bay * 0.82, wallHeight],
          1,
        ),
      );
      if (aisles) {
        const h = wallHeight * 0.55;
        out.push(plane([side * naveWidth, floorY + h / 2, z], [side, 0, 0], [bay * 0.82, h], 1));
      }
    }
  }

  for (let i = 0; i <= bays; i++) {
    const z = i * bay - naveLength / 2;
    out.push(plane([0, floorY + wallHeight * 0.55, z], Z, [naveWidth * 0.96, wallHeight * 1.1], 2));
  }

  for (let k = 0; k < tiers; k++) {
    const t = (k + 1) / (tiers + 1);
    const y = floorY + wallHeight + t * 0.35;
    out.push(plane([0, y, 0], Y, [naveWidth * (1 - t * 0.8), naveLength * (1 - t * 0.15)], 3, Z));
  }

  const windowSize = naveWidth * 1.25;
  out.push(plane([0, floorY + wallHeight * 0.7, naveLength / 2 + 0.04], Z, [windowSize, windowSize], 4));
  const spireHeight = rng.range(0.5, 0.9);
  const spireY = floorY + wallHeight + spireHeight / 2;
  const spireZ = -naveLength / 2 + bay * 0.5;
  out.push(plane([0, spireY, spireZ], Z, [naveWidth * 0.35, spireHeight], 4));
  out.push(plane([0, spireY, spireZ], X, [naveWidth * 0.35, spireHeight], 4));
  return out;
}

/** One enormous sheet. Rare, and good for scale contrast. */
export function monolith(rng: Rng, opts: ArrangementParams = {}): LocalPlane[] {
  const aspect = opts.aspect ?? rng.range(0.4, 1);
  return [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1.6 * aspect, 1.6], group: 0 }];
}

/**
 * Registry used by the world generator.
 * `weight` is the default relative frequency. `orient` says how a structure may
 * be rotated when placed: 'free' (any rotation) or 'yaw' (keeps +Y up).
 */
export const ARRANGEMENTS: Record<string, Arrangement> = {
  stack: { build: stack, weight: 1.2, orient: 'free' },
  lattice: { build: lattice, weight: 1.0, orient: 'free' },
  crossed: { build: crossed, weight: 0.8, orient: 'free' },
  spiral: { build: spiral, weight: 1.0, orient: 'free' },
  cloud: { build: cloud, weight: 1.2, orient: 'free' },
  shell: { build: shell, weight: 0.6, orient: 'free' },
  fan: { build: fan, weight: 0.8, orient: 'free' },
  cathedral: { build: cathedral, weight: 0.7, orient: 'yaw' },
  monolith: { build: monolith, weight: 0.15, orient: 'free' },
};

export const ARRANGEMENT_NAMES = Object.keys(ARRANGEMENTS);

/** Build one local plane from a centre, a normal and a size. Handy in custom recipes. */
export const localPlane = plane;
