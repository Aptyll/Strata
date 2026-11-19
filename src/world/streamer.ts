// Plane streaming: keeps a fixed number of GPU "slots" filled with the planes
// that matter most to the camera right now, so an endless world fits in a
// fixed budget.
//
// Each slot is in one of four states:
//   FREE     nothing here
//   AWAKE    drawn and simulated
//   ASLEEP   drawn, simulation frozen (keeps its particle state)
//   LEAVING  fading out; freed when the fade reaches zero
//
// A plane keeps the same slot index for as long as it is resident, so the
// engine can key per-plane GPU buffers by slot and never shuffle them.

import type { Vec3 } from '../core/contracts';
import { smoothstep } from './math';
import type { Plane, PlaneSource } from './world';

export const SLOT_FREE = 0;
export const SLOT_AWAKE = 1;
export const SLOT_ASLEEP = 2;
export const SLOT_LEAVING = 3;

/** Bytes per slot in `instanceBuffer`. Layout is documented in docs/world.md. */
export const INSTANCE_STRIDE = 64;

export type SlotState = typeof SLOT_FREE | typeof SLOT_AWAKE | typeof SLOT_ASLEEP | typeof SLOT_LEAVING;

export interface StreamerOptions {
  /** Slot count: planes resident at once. Default 256. */
  maxPlanes?: number;
  /** Planes simulated at once. Default 64. */
  maxAwake?: number;
  /** Hard cap on the sum of plane.particles over all resident planes. Default none. */
  maxParticles?: number;
  /** Planes farther than this are never resident. Default 2.5 sectors. */
  loadRadius?: number;
  /** Outer fraction of loadRadius over which planes fade to nothing. Default 0.3. */
  fadeBand?: number;
  /** Seconds to fade in or out. Default 1.5. */
  fadeTime?: number;
  /** Score bonus for planes already resident, to stop flicker. Default 1.3. */
  hysteresis?: number;
  /** Score bonus for planes in front of the camera (needs camera.forward). Default 2. */
  viewBias?: number;
  /** Seconds between re-evaluations of which planes are resident. Fades still update every call. Default 0.1. */
  selectInterval?: number;
  /** Camera travel before the candidate list is rebuilt. Default 5% of loadRadius. */
  requeryDistance?: number;
}

export interface StreamCamera {
  position: Vec3;
  /** Unit view direction. Optional: without it planes are ranked by size and distance only. */
  forward?: Vec3;
}

export interface Slot {
  readonly index: number;
  plane: Plane | null;
  state: SlotState;
  /** What the renderer should multiply brightness by: time fade times distance fade. */
  fade: number;
  /** Time fade only. */
  presence: number;
  /** Importance at the last selection (roughly apparent size). */
  score: number;
  /** Distance to the camera at the last selection. */
  dist: number;
}

export interface SlotEvent {
  slot: number;
  plane: Plane;
}

/** What changed in one update. `spawned` means "create this slot's particles from plane.seed and plane.behavior". */
export interface StreamDiff {
  spawned: SlotEvent[];
  despawned: SlotEvent[];
  woke: SlotEvent[];
  slept: SlotEvent[];
}

export interface StreamStats {
  resident: number;
  awake: number;
  asleep: number;
  leaving: number;
  particles: number;
  candidates: number;
}

export interface Streamer {
  /** Advance streaming. Call once per frame with seconds since the last call. */
  update(camera: StreamCamera, dt?: number): StreamDiff;
  /** Drop everything, for example after teleporting the camera. */
  reset(): StreamDiff;
  readonly slots: readonly Slot[];
  readonly stats: StreamStats;
  readonly maxPlanes: number;
  readonly maxAwake: number;
  readonly loadRadius: number;
  /** maxPlanes * INSTANCE_STRIDE bytes, ready to upload. Layout in docs/world.md. */
  readonly instanceBuffer: ArrayBuffer;
  readonly instanceFloats: Float32Array;
  readonly instanceUints: Uint32Array;
}

interface Candidate {
  plane: Plane;
  dist: number;
  raw: number;
  score: number;
}

const emptyDiff = (): StreamDiff => ({ spawned: [], despawned: [], woke: [], slept: [] });

export function createStreamer(world: PlaneSource, options: StreamerOptions = {}): Streamer {
  const maxPlanes = options.maxPlanes ?? 256;
  const maxAwake = Math.min(options.maxAwake ?? 64, maxPlanes);
  const maxParticles = options.maxParticles ?? Infinity;
  const loadRadius = options.loadRadius ?? (world.sectorSize ? world.sectorSize * 2.5 : 0);
  if (!(loadRadius > 0)) throw new Error('createStreamer needs options.loadRadius for this world');
  const fadeBand = options.fadeBand ?? 0.3;
  const fadeTime = options.fadeTime ?? 1.5;
  const hysteresis = options.hysteresis ?? 1.3;
  const viewBias = options.viewBias ?? 2;
  const requeryDistance = options.requeryDistance ?? loadRadius * 0.05;
  const selectInterval = options.selectInterval ?? 0.1;

  const slots: Slot[] = Array.from({ length: maxPlanes }, (_, index) => ({
    index,
    plane: null,
    state: SLOT_FREE,
    fade: 0, // what the renderer should use: time fade times distance fade
    presence: 0, // time fade only
    score: 0,
    dist: 0,
  }));
  const freeList: number[] = [];
  for (let i = maxPlanes - 1; i >= 0; i--) freeList.push(i);
  const slotByKey = new Map<string, Slot>();

  const instanceBuffer = new ArrayBuffer(maxPlanes * INSTANCE_STRIDE);
  const f32 = new Float32Array(instanceBuffer);
  const u32 = new Uint32Array(instanceBuffer);

  let candidates: Plane[] = [];
  let queryCenter: Vec3 | null = null;
  let residentParticles = 0;
  let sinceSelect = 0;
  const scored: Candidate[] = [];
  const stats: StreamStats = { resident: 0, awake: 0, asleep: 0, leaving: 0, particles: 0, candidates: 0 };

  function writeStatic(slot: Slot, p: Plane): void {
    const o = slot.index * 16;
    f32[o] = p.position[0];
    f32[o + 1] = p.position[1];
    f32[o + 2] = p.position[2];
    f32[o + 3] = p.size[0];
    f32[o + 4] = p.rotation[0];
    f32[o + 5] = p.rotation[1];
    f32[o + 6] = p.rotation[2];
    f32[o + 7] = p.rotation[3];
    f32[o + 8] = p.size[1];
    u32[o + 9] = p.behavior;
    u32[o + 10] = p.seed;
    u32[o + 13] = p.particles;
    u32[o + 14] = p.id;
  }

  function release(slot: Slot, diff: StreamDiff): void {
    const p = slot.plane;
    if (!p) return;
    diff.despawned.push({ slot: slot.index, plane: p });
    slotByKey.delete(p.key);
    residentParticles -= p.particles;
    slot.plane = null;
    slot.state = SLOT_FREE;
    slot.fade = 0;
    slot.presence = 0;
    const o = slot.index * 16;
    u32[o + 11] = SLOT_FREE;
    f32[o + 12] = 0;
    freeList.push(slot.index);
  }

  function fadingVictim(): Slot | null {
    let victim: Slot | null = null;
    for (const s of slots) {
      if (s.state === SLOT_LEAVING && (!victim || s.presence < victim.presence)) victim = s;
    }
    return victim;
  }

  // Find a slot for a new plane without ever exceeding either budget. When
  // there is no room, the fading plane closest to invisible is cut short.
  function acquire(plane: Plane, diff: StreamDiff): Slot | null {
    while (freeList.length === 0 || residentParticles + plane.particles > maxParticles) {
      const victim = fadingVictim();
      if (!victim) return null;
      release(victim, diff);
    }
    return slots[freeList.pop() as number];
  }

  function update(camera: StreamCamera, dt = 0): StreamDiff {
    const diff = emptyDiff();
    const cam = camera.position;
    const fwd = camera.forward;

    sinceSelect += dt;
    if (!queryCenter || sinceSelect >= selectInterval) {
      sinceSelect = 0;
      if (
        !queryCenter ||
        Math.hypot(cam[0] - queryCenter[0], cam[1] - queryCenter[1], cam[2] - queryCenter[2]) >
          requeryDistance
      ) {
        candidates = world.query(cam, loadRadius + requeryDistance, []);
        queryCenter = [cam[0], cam[1], cam[2]];
      }

      // Score every candidate in range by roughly how large it looks.
      scored.length = 0;
      for (let i = 0; i < candidates.length; i++) {
        const p = candidates[i];
        const dx = p.position[0] - cam[0];
        const dy = p.position[1] - cam[1];
        const dz = p.position[2] - cam[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist >= loadRadius) continue;
        const extent = p.radius * 2;
        let score = extent / Math.max(dist, extent * 0.25);
        if (fwd && dist > p.radius) {
          const facing = (dx * fwd[0] + dy * fwd[1] + dz * fwd[2]) / dist;
          score *= 1 + (viewBias - 1) * smoothstep(-0.2, 0.7, facing);
        }
        const slot = slotByKey.get(p.key);
        const resident = slot && slot.state !== SLOT_LEAVING;
        scored.push({ plane: p, dist, raw: score, score: resident ? score * hysteresis : score });
      }
      stats.candidates = scored.length;
      scored.sort((a, b) => b.score - a.score || (a.plane.key < b.plane.key ? -1 : 1));

      // Take the best that fit the plane and particle budgets.
      const wanted = new Map<string, Candidate>();
      let particles = 0;
      for (let i = 0; i < scored.length && wanted.size < maxPlanes; i++) {
        const c = scored[i];
        if (particles + c.plane.particles > maxParticles) continue;
        particles += c.plane.particles;
        wanted.set(c.plane.key, c);
      }

      // Residents that lost their place start fading out.
      for (const slot of slots) {
        const p = slot.plane;
        if (!p || slot.state === SLOT_LEAVING) continue;
        if (!wanted.has(p.key)) {
          if (slot.state === SLOT_AWAKE) diff.slept.push({ slot: slot.index, plane: p });
          slot.state = SLOT_LEAVING;
        }
      }

      // Give every wanted plane a slot.
      for (const c of wanted.values()) {
        let slot = slotByKey.get(c.plane.key);
        if (!slot) {
          slot = acquire(c.plane, diff) ?? undefined;
          if (!slot) continue;
          residentParticles += c.plane.particles;
          slot.plane = c.plane;
          slot.state = SLOT_ASLEEP;
          slot.presence = 0;
          slotByKey.set(c.plane.key, slot);
          writeStatic(slot, c.plane);
          diff.spawned.push({ slot: slot.index, plane: c.plane });
        } else if (slot.state === SLOT_LEAVING) {
          slot.state = SLOT_ASLEEP; // came back before it finished fading
        }
        slot.score = c.raw;
        slot.dist = c.dist;
      }

      // Wake the most important residents, with the same stickiness.
      const live: Slot[] = [];
      for (const slot of slots) {
        if (slot.state === SLOT_AWAKE || slot.state === SLOT_ASLEEP) live.push(slot);
      }
      live.sort(
        (a, b) =>
          b.score * (b.state === SLOT_AWAKE ? hysteresis : 1) -
            a.score * (a.state === SLOT_AWAKE ? hysteresis : 1) || a.index - b.index,
      );
      for (let i = 0; i < live.length; i++) {
        const slot = live[i];
        const next = i < maxAwake ? SLOT_AWAKE : SLOT_ASLEEP;
        if (next === slot.state || !slot.plane) continue;
        (next === SLOT_AWAKE ? diff.woke : diff.slept).push({ slot: slot.index, plane: slot.plane });
        slot.state = next;
      }
    }

    // Fades, then pack per-frame fields.
    const step = fadeTime > 0 ? dt / fadeTime : 1;
    const fadeStart = loadRadius * (1 - fadeBand);
    stats.resident = stats.awake = stats.asleep = stats.leaving = stats.particles = 0;
    for (const slot of slots) {
      const p = slot.plane;
      if (!p) continue;
      if (slot.state === SLOT_LEAVING) {
        slot.presence -= step;
        if (slot.presence <= 0) {
          release(slot, diff);
          continue;
        }
        stats.leaving++;
      } else {
        slot.presence = Math.min(1, slot.presence + step);
        if (slot.state === SLOT_AWAKE) stats.awake++;
        else stats.asleep++;
      }
      const dist = Math.hypot(p.position[0] - cam[0], p.position[1] - cam[1], p.position[2] - cam[2]);
      slot.fade = slot.presence * (1 - smoothstep(fadeStart, loadRadius, dist));
      stats.resident++;
      stats.particles += p.particles;
      const o = slot.index * 16;
      u32[o + 11] = slot.state;
      f32[o + 12] = slot.fade;
    }
    return diff;
  }

  function reset(): StreamDiff {
    const diff = emptyDiff();
    for (const slot of slots) if (slot.state !== SLOT_FREE) release(slot, diff);
    queryCenter = null;
    return diff;
  }

  return {
    update,
    reset,
    slots,
    stats,
    maxPlanes,
    maxAwake,
    loadRadius,
    instanceBuffer,
    instanceFloats: f32,
    instanceUints: u32,
  };
}
