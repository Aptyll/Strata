// Public entry point for the world modules. See docs/world.md.
export { createWorld, createStaticWorld, buildStructure } from './world';
export type { Plane, PlaneSource, World, WorldOptions, StructureOptions } from './world';
export {
  createStreamer,
  INSTANCE_STRIDE,
  SLOT_FREE,
  SLOT_AWAKE,
  SLOT_ASLEEP,
  SLOT_LEAVING,
} from './streamer';
export type {
  Streamer,
  StreamerOptions,
  StreamCamera,
  StreamDiff,
  StreamStats,
  Slot,
  SlotEvent,
  SlotState,
} from './streamer';
export { toPlaneDesc, selectPlanes, createWorldScene } from './scene';
export type { PlaneDescOptions, WorldSceneOptions } from './scene';
export { createWorldDriver, startStreamingWorld, createEngineWorld, openingCamera } from './driver';
export type { WorldDriver, WorldDriverOptions, StreamingWorld, StreamingWorldOptions } from './driver';
export { ARRANGEMENTS, ARRANGEMENT_NAMES, localPlane } from './arrangements';
export type { Arrangement, ArrangementParams, LocalPlane } from './arrangements';
export { Rng, hash32, seedFrom } from './rng';
export * as math from './math';
