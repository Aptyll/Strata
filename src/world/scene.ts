// Bridges from world data to the shared engine contracts (src/core/contracts.ts).

import type { PlaneDesc, Scene, Vec3 } from '../core/contracts';
import { createStreamer } from './streamer';
import type { StreamerOptions } from './streamer';
import type { Plane, PlaneSource } from './world';

export interface PlaneDescOptions {
  /** Upper bound on particleCount per plane. Default: the plane's own hint. */
  maxParticlesPerPlane?: number;
}

/**
 * Convert a world plane to the engine's PlaneDesc.
 * `behaviorIds` maps the plane's behavior index to a registered behavior id;
 * indices wrap, so any non-empty list works.
 */
export function toPlaneDesc(
  plane: Plane,
  behaviorIds: readonly string[],
  options: PlaneDescOptions = {},
): PlaneDesc {
  if (behaviorIds.length === 0) throw new Error('toPlaneDesc needs at least one behavior id');
  return {
    id: plane.key,
    position: [plane.position[0], plane.position[1], plane.position[2]],
    rotation: [plane.rotation[0], plane.rotation[1], plane.rotation[2], plane.rotation[3]],
    halfSize: [plane.size[0] / 2, plane.size[1] / 2],
    behaviorId: behaviorIds[plane.behavior % behaviorIds.length],
    particleCount: Math.min(plane.particles, options.maxParticlesPerPlane ?? Infinity),
    seed: plane.seed / 4294967296,
  };
}

/**
 * The planes a streamer would hold for a camera standing at `center`:
 * the best `maxPlanes` within the budgets, most important first.
 */
export function selectPlanes(source: PlaneSource, center: Vec3, options: StreamerOptions = {}): Plane[] {
  const streamer = createStreamer(source, options);
  streamer.update({ position: center }, 0);
  return streamer.slots
    .filter((slot) => slot.plane !== null)
    .sort((a, b) => b.score - a.score)
    .map((slot) => slot.plane as Plane);
}

export interface WorldSceneOptions extends StreamerOptions, PlaneDescOptions {
  /** Registered behavior ids to hand out. */
  behaviorIds: readonly string[];
  /** Where the camera looks. Default: the middle of sector 0,0,0. */
  center?: Vec3;
  name?: string;
  seed?: number;
}

/**
 * A fixed Scene cut out of a world around one point. Works with the engine's
 * loadScene today; use createStreamer directly once planes can be added and
 * removed while running.
 */
export function createWorldScene(source: PlaneSource, options: WorldSceneOptions): Scene {
  const half = (source.sectorSize ?? 0) / 2;
  const center: Vec3 = options.center ?? [half, half, half];
  const planes = selectPlanes(source, center, options).map((p) =>
    toPlaneDesc(p, options.behaviorIds, options),
  );
  return {
    version: 1,
    name: options.name,
    seed: options.seed ?? 0,
    planes,
    camera: {
      target: center,
      yaw: 0.6,
      pitch: 0.2,
      distance: (source.sectorSize ?? 100) * 0.9,
      fovY: Math.PI / 3,
    },
    render: { brightness: 1 },
  };
}
