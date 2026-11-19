// The world: an endless, seeded field of plane structures.
//
// Space is cut into cubic sectors. Each sector's contents are a pure function
// of (world seed, sector coordinates), so nothing is stored: a sector can be
// thrown away and rebuilt identically at any time. That is what lets the
// streamer treat the world as infinite.

import type { Quat, Vec2, Vec3 } from '../core/contracts';
import { ARRANGEMENTS } from './arrangements';
import type { Arrangement, ArrangementParams } from './arrangements';
import { Rng, hash32, seedFrom } from './rng';
import { quatFromAxisAngle, quatMul, rotate } from './math';

/** One sheet of the world, as plain data. */
export interface Plane {
  /** Stable unique name, e.g. "3,-1,0:17". */
  key: string;
  /** uint32 hash of the key, for GPU-side use. */
  id: number;
  /** World-space centre. */
  position: Vec3;
  /** Unit quaternion, xyzw. The plane lies in its local XY plane; local +Z is the normal. */
  rotation: Quat;
  /** Full extents [width, height] in world units. */
  size: Vec2;
  /** Integer in [0, behaviorCount). The engine decides what each index means. */
  behavior: number;
  /** uint32 seed for this plane's particles. */
  seed: number;
  /** Suggested particle capacity (a hint, from area times particleDensity). */
  particles: number;
  /** Bounding-sphere radius (half the diagonal). */
  radius: number;
  /** Family index inside its structure. */
  group: number;
  /** Arrangement that produced it, or "stray". */
  kind: string;
}

/** Anything the streamer can pull planes from. */
export interface PlaneSource {
  /** Planes that may lie within `radius` of `center` (a superset is fine). Appends to `out`. */
  query(center: Vec3, radius: number, out?: Plane[]): Plane[];
  /** Sector edge, if the source has one. Used for the default load radius. */
  sectorSize?: number;
}

export interface WorldOptions {
  seed?: number | string;
  /** Edge of a sector in world units. Default 100. */
  sectorSize?: number;
  /** Chance a sector holds a structure. Default 0.7. */
  density?: number;
  /** How many behavior indices to hand out. Default 8. */
  behaviorCount?: number;
  /** Sectors per region edge. A region favours one arrangement. Default 3. */
  regionSize?: number;
  /** Chance a structure follows its region's favourite. Default 0.5. */
  regionBias?: number;
  /** Mean loose planes per sector. Default 1. */
  strays?: number;
  /** Particles per square world unit, for the `particles` hint. Default 400. */
  particleDensity?: number;
  minParticles?: number;
  maxParticles?: number;
  /** Sectors kept in the generation cache. Default 2048. */
  cacheSectors?: number;
  /** Per-arrangement weight overrides, e.g. { cathedral: 5, cloud: 0 }. */
  weights?: Record<string, number> | null;
  /** Recipe registry. Defaults to the built-in ARRANGEMENTS. */
  arrangements?: Record<string, Arrangement>;
}

export interface StructureOptions extends WorldOptions {
  /** Centre of the structure. Default origin. */
  position?: Vec3;
  /** World radius the unit-sized recipe is scaled to. Default 1. */
  radius?: number;
  /** Placement rotation. Random (respecting the recipe's `orient`) if omitted. */
  rotation?: Quat;
  /** Behavior index per group. Random if omitted. */
  behaviors?: number[];
  /** Passed through to the recipe. */
  params?: ArrangementParams;
  /** Prefix for plane keys. Default "<kind>@<seed>". */
  keyPrefix?: string;
}

export interface World extends PlaneSource {
  seed: number;
  sectorSize: number;
  behaviorCount: number;
  /** Planes of one sector. Deterministic and cached. */
  sector(cx: number, cy: number, cz: number): Plane[];
  config: Required<WorldOptions>;
}

const DEFAULTS: Required<WorldOptions> = {
  seed: 1,
  sectorSize: 100,
  density: 0.7,
  behaviorCount: 8,
  regionSize: 3,
  regionBias: 0.5,
  strays: 1,
  particleDensity: 400,
  minParticles: 1024,
  maxParticles: 1 << 20,
  cacheSectors: 2048,
  weights: null,
  arrangements: ARRANGEMENTS,
};

/** Fill in defaults, ignoring keys explicitly set to undefined. */
function resolve(options: WorldOptions): Required<WorldOptions> {
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof WorldOptions)[]) {
    if (options[key] !== undefined) (cfg as Record<string, unknown>)[key] = options[key];
  }
  return cfg;
}

function particleHint(size: Vec2, cfg: Required<WorldOptions>): number {
  const n = Math.round(size[0] * size[1] * cfg.particleDensity);
  return Math.min(cfg.maxParticles, Math.max(cfg.minParticles, n));
}

function shuffledBehaviors(rng: Rng, behaviorCount: number): number[] {
  const ids = Array.from({ length: behaviorCount }, (_, i) => i);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

/** Build one structure in world space. Usable on its own for hand-made scenes. */
export function buildStructure(kind: string, opts: StructureOptions = {}): Plane[] {
  const cfg = resolve(opts);
  const entry = cfg.arrangements[kind];
  if (!entry) throw new Error(`Unknown arrangement "${kind}"`);
  const seed = seedFrom(opts.seed ?? 1);
  const rng = new Rng(seed);
  const position = opts.position ?? [0, 0, 0];
  const radius = opts.radius ?? 1;
  let rotation = opts.rotation;
  if (!rotation) {
    const r = rng.fork(1);
    rotation = entry.orient === 'yaw' ? quatFromAxisAngle([0, 1, 0], r.range(0, Math.PI * 2)) : r.quat();
  }
  const behaviors = opts.behaviors ?? shuffledBehaviors(rng.fork(2), cfg.behaviorCount);
  const local = entry.build(rng.fork(3), opts.params);
  const prefix = opts.keyPrefix ?? `${kind}@${seed}`;
  return local.map((lp, i) => {
    const p = rotate(rotation, lp.position);
    const size: Vec2 = [lp.size[0] * radius, lp.size[1] * radius];
    const key = `${prefix}:${i}`;
    return {
      key,
      id: hash32(seedFrom(key)),
      position: [position[0] + p[0] * radius, position[1] + p[1] * radius, position[2] + p[2] * radius],
      rotation: quatMul(rotation, lp.rotation),
      size,
      behavior: behaviors[lp.group % behaviors.length],
      seed: hash32(seed, i, 0x51a7),
      particles: particleHint(size, cfg),
      radius: Math.hypot(size[0], size[1]) / 2,
      group: lp.group,
      kind,
    };
  });
}

/** Create an endless procedural world. Same options, same world, on every machine. */
export function createWorld(options: WorldOptions = {}): World {
  const cfg = resolve(options);
  const worldSeed = seedFrom(cfg.seed);
  const S = cfg.sectorSize;
  const names = Object.keys(cfg.arrangements);
  const weights = names.map((n) => cfg.weights?.[n] ?? cfg.arrangements[n].weight ?? 1);
  if (!weights.some((w) => w > 0)) throw new Error('All arrangement weights are zero');
  const cache = new Map<string, Plane[]>();

  function regionKind(cx: number, cy: number, cz: number): string {
    const R = cfg.regionSize;
    const r = new Rng(hash32(worldSeed, Math.floor(cx / R), Math.floor(cy / R), Math.floor(cz / R), 0xb10e));
    return names[r.weighted(weights)];
  }

  function generate(cx: number, cy: number, cz: number): Plane[] {
    const sectorSeed = hash32(worldSeed, cx, cy, cz);
    const rng = new Rng(sectorSeed);
    const origin = [cx * S, cy * S, cz * S];
    const prefix = `${cx},${cy},${cz}`;
    const planes: Plane[] = [];

    if (rng.chance(cfg.density)) {
      const kind = rng.chance(cfg.regionBias) ? regionKind(cx, cy, cz) : names[rng.weighted(weights)];
      const radius = S * rng.range(0.25, 0.48);
      const slack = S / 2 - radius;
      const position: Vec3 = [
        origin[0] + S / 2 + rng.range(-slack, slack),
        origin[1] + S / 2 + rng.range(-slack, slack),
        origin[2] + S / 2 + rng.range(-slack, slack),
      ];
      const built = buildStructure(kind, {
        ...cfg,
        seed: rng.u32(),
        position,
        radius,
        rotation: undefined,
        behaviors: undefined,
        params: undefined,
        keyPrefix: prefix,
      });
      for (const p of built) planes.push(p);
    }

    // Loose single sheets drifting between structures.
    const strayRng = rng.fork(0x57a7);
    const strayCount = Math.floor(cfg.strays) + (strayRng.chance(cfg.strays % 1) ? 1 : 0);
    const count = strayCount > 0 ? strayRng.intRange(0, strayCount * 2) : 0;
    for (let i = 0; i < count; i++) {
      const s = S * (0.02 + 0.1 * Math.pow(strayRng.float(), 2));
      const size: Vec2 = [s * strayRng.range(0.6, 1.6), s];
      const key = `${prefix}:s${i}`;
      planes.push({
        key,
        id: hash32(seedFrom(key)),
        position: [
          origin[0] + strayRng.range(0, S),
          origin[1] + strayRng.range(0, S),
          origin[2] + strayRng.range(0, S),
        ],
        rotation: strayRng.quat(),
        size,
        behavior: strayRng.int(cfg.behaviorCount),
        seed: strayRng.u32(),
        particles: particleHint(size, cfg),
        radius: Math.hypot(size[0], size[1]) / 2,
        group: 0,
        kind: 'stray',
      });
    }
    return planes;
  }

  function sector(cx: number, cy: number, cz: number): Plane[] {
    const key = `${cx},${cy},${cz}`;
    let planes = cache.get(key);
    if (planes) {
      cache.delete(key);
      cache.set(key, planes);
      return planes;
    }
    planes = generate(cx, cy, cz);
    cache.set(key, planes);
    if (cache.size > cfg.cacheSectors) cache.delete(cache.keys().next().value as string);
    return planes;
  }

  /**
   * All planes in sectors touching the sphere (center, radius). This is a
   * coarse superset: callers filter by exact distance.
   */
  function query(center: Vec3, radius: number, out: Plane[] = []): Plane[] {
    const lo = [0, 1, 2].map((a) => Math.floor((center[a] - radius) / S));
    const hi = [0, 1, 2].map((a) => Math.floor((center[a] + radius) / S));
    const r2 = radius * radius;
    for (let cz = lo[2]; cz <= hi[2]; cz++) {
      const dz = Math.max(cz * S - center[2], 0, center[2] - (cz + 1) * S);
      for (let cy = lo[1]; cy <= hi[1]; cy++) {
        const dy = Math.max(cy * S - center[1], 0, center[1] - (cy + 1) * S);
        for (let cx = lo[0]; cx <= hi[0]; cx++) {
          const dx = Math.max(cx * S - center[0], 0, center[0] - (cx + 1) * S);
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const planes = sector(cx, cy, cz);
          for (let i = 0; i < planes.length; i++) out.push(planes[i]);
        }
      }
    }
    return out;
  }

  return { seed: worldSeed, sectorSize: S, behaviorCount: cfg.behaviorCount, sector, query, config: cfg };
}

/**
 * Wrap a fixed list of planes (for example several buildStructure results)
 * so it can be streamed the same way as an endless world.
 */
export function createStaticWorld(planes: Plane[]): PlaneSource & { planes: Plane[] } {
  const seen = new Set();
  for (const p of planes) {
    if (seen.has(p.key)) throw new Error(`Duplicate plane key "${p.key}"`);
    seen.add(p.key);
  }
  return {
    planes,
    query(center: Vec3, radius: number, out: Plane[] = []): Plane[] {
      for (let i = 0; i < planes.length; i++) {
        const p = planes[i];
        const d = Math.hypot(p.position[0] - center[0], p.position[1] - center[1], p.position[2] - center[2]);
        if (d <= radius + p.radius) out.push(p);
      }
      return out;
    },
  };
}
