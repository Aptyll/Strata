// Runs a streamer against a live engine: turns its slot changes into
// addPlane / removePlane calls, fades planes with PlaneDesc.brightness and
// pauses the ones that are asleep. Depends only on the PlaneHost contract.

import type { AppContext, PlaneHost, PlaneInstance } from '../core/contracts';
import { toPlaneDesc } from './scene';
import type { PlaneDescOptions } from './scene';
import { createStreamer, SLOT_AWAKE } from './streamer';
import type { StreamCamera, Streamer, StreamerOptions } from './streamer';
import { createWorld } from './world';
import type { PlaneSource, WorldOptions } from './world';

export interface WorldDriverOptions extends StreamerOptions, PlaneDescOptions {
  /** Registered behavior ids to hand out. Plane behavior indices wrap around this list. */
  behaviorIds: readonly string[];
  /**
   * Planes created per update at most. Creating a plane allocates and fills
   * its particle buffer, so spreading spawns out avoids hitches. Default 2.
   */
  maxSpawnsPerFrame?: number;
  /** Smallest brightness change worth a uniform upload. Default 1/128. */
  brightnessStep?: number;
}

export interface WorldDriver {
  /** Call once per frame, before the frame is encoded. */
  update(camera: StreamCamera, dt: number): void;
  /** Remove every plane this driver created, e.g. before loading another scene. */
  clear(): void;
  readonly streamer: Streamer;
  /** Planes waiting for their turn to be created. */
  readonly pending: number;
}

export function createWorldDriver(
  host: PlaneHost,
  source: PlaneSource,
  options: WorldDriverOptions,
): WorldDriver {
  const streamer = createStreamer(source, options);
  const maxSpawns = options.maxSpawnsPerFrame ?? 2;
  const step = options.brightnessStep ?? 1 / 128;
  const instances: (PlaneInstance | null)[] = new Array(streamer.maxPlanes).fill(null);
  const waiting = new Set<number>();

  function drop(slot: number): void {
    waiting.delete(slot);
    const instance = instances[slot];
    if (instance) host.removePlane(instance);
    instances[slot] = null;
  }

  function update(camera: StreamCamera, dt: number): void {
    const diff = streamer.update(camera, dt);
    for (const e of diff.despawned) drop(e.slot);
    for (const e of diff.spawned) waiting.add(e.slot);

    // Create the most important waiting planes first, a few per frame.
    if (waiting.size > 0) {
      const order = [...waiting].sort((a, b) => streamer.slots[b].score - streamer.slots[a].score);
      for (const index of order.slice(0, maxSpawns)) {
        const slot = streamer.slots[index];
        waiting.delete(index);
        if (!slot.plane) continue;
        const desc = toPlaneDesc(slot.plane, options.behaviorIds, options);
        desc.brightness = slot.fade;
        instances[index] = host.addPlane(desc);
      }
    }

    for (const slot of streamer.slots) {
      const instance = instances[slot.index];
      if (!instance) continue;
      instance.paused = slot.state !== SLOT_AWAKE;
      const shown = instance.desc.brightness ?? 1;
      const settled = (slot.fade === 0 || slot.fade === 1) && shown !== slot.fade;
      if (settled || Math.abs(shown - slot.fade) >= step) {
        instance.desc.brightness = slot.fade;
        host.updatePlane(instance);
      }
    }
  }

  function clear(): void {
    streamer.reset();
    for (let i = 0; i < instances.length; i++) drop(i);
  }

  return {
    update,
    clear,
    streamer,
    get pending() {
      return waiting.size;
    },
  };
}

export interface StreamingWorldOptions extends WorldOptions, Omit<WorldDriverOptions, 'behaviorIds'> {
  /** Defaults to every registered behavior. */
  behaviorIds?: readonly string[];
}

export interface StreamingWorld extends WorldDriver {
  /** Stream around the app's camera. Call once per frame after the camera updates. */
  tick(dt: number): void;
}

/**
 * One call to put an endless world into the running app: builds the world,
 * streams it through the app's PlaneHost and follows the app's camera.
 * World units are scaled for the engine (sheets a few units across).
 */
export function startStreamingWorld(app: AppContext, options: StreamingWorldOptions = {}): StreamingWorld {
  const world = createWorld({
    sectorSize: 12,
    particleDensity: 5000,
    minParticles: 2000,
    maxParticles: 2_000_000,
    ...options,
  });
  const driver = createWorldDriver(app, world, {
    maxPlanes: 192,
    maxAwake: 64,
    maxParticles: 8_000_000,
    ...options,
    behaviorIds: options.behaviorIds ?? app.behaviors.map((b) => b.id),
  });
  return {
    update: driver.update,
    clear: driver.clear,
    streamer: driver.streamer,
    get pending() {
      return driver.pending;
    },
    tick(dt: number) {
      const eye = app.camera.eye();
      const target = app.camera.state.target;
      const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
      const l = Math.hypot(d[0], d[1], d[2]);
      driver.update({ position: eye, forward: l > 0 ? [d[0] / l, d[1] / l, d[2] / l] : undefined }, dt);
    },
  };
}
