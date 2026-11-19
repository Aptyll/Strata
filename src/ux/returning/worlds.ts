/**
 * A world as something that can be put away and taken out again: the Scene
 * contract (every sheet's rule, sliders, seed and place, the camera, the
 * brightness) plus a name for the menu.
 *
 * A dice seed is not enough to keep a world. A seed gives the same world only
 * while the list of behaviors stays the same, and it knows nothing about a
 * slider someone moved afterwards. So a kept world stores what is on screen.
 */
import type { Behavior, PlaneDesc, Scene } from "../../core/contracts";

/** A world exactly as it was. */
export interface Snapshot {
  /** Unique among a visitor's snapshots. */
  id: string;
  /** What its particles were doing, for the menu: "galaxy + flow". */
  name: string;
  /** Local day it was taken, "YYYY-MM-DD". */
  day: string;
  /** Dice seed it was rolled from, when it came from the dice. Only used to put that roll back in the page link. */
  seed?: number;
  /** Color theme at the time (src/ux/theme). */
  theme?: string;
  scene: Scene;
}

/** What the particles of a scene are doing, as the one or two rules most sheets follow. */
export function worldName(scene: Scene, behaviors: readonly Behavior[]): string {
  const sheets = new Map<string, number>();
  for (const p of scene.planes) sheets.set(p.behaviorId, (sheets.get(p.behaviorId) ?? 0) + 1);
  // Map keeps first-seen order, and the sort is stable, so ties go to the rule that appears first.
  const lead = [...sheets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const label = (id: string) => behaviors.find((b) => b.id === id)?.label ?? id;
  return lead.map(([id]) => label(id)).join(" + ") || "empty";
}

/** True when every sheet's rule still exists, so the engine can load the scene. */
export const usable = (scene: Scene, behaviors: readonly Behavior[]): boolean =>
  scene.planes.length > 0 && scene.planes.every((p) => behaviors.some((b) => b.id === p.behaviorId));

/** What makes a sheet the same sheet: its rule, its sliders, its seed and where it floats. Not how many particles it holds. */
function sheetIdentity(p: PlaneDesc): string {
  const params = Object.entries(p.params ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([p.behaviorId, p.seed, params, p.position, p.rotation, p.halfSize]);
}

/**
 * True when two scenes are the same world seen from anywhere, at any particle
 * count and brightness. Keeping a world twice then refreshes it instead of
 * listing it twice.
 */
export function sameWorld(a: Scene, b: Scene): boolean {
  if (a.planes.length !== b.planes.length) return false;
  return a.planes.every((p, i) => sheetIdentity(p) === sheetIdentity(b.planes[i]));
}

let serial = 0;
/** An id that is unique enough for one browser's list. */
export const newId = (now: number = Date.now()): string => `${now.toString(36)}${(serial++ % 1296).toString(36).padStart(2, "0")}`;

export interface SnapshotExtras {
  day: string;
  seed?: number;
  theme?: string;
}

/**
 * Copy a live scene into a snapshot. The engine keeps mutating the scene it
 * hands out (rolls and sliders write into the same plane descriptions), so
 * this takes a deep copy.
 */
export function takeSnapshot(scene: Scene, behaviors: readonly Behavior[], extras: SnapshotExtras): Snapshot {
  const copy = cloneScene(scene);
  const snapshot: Snapshot = { id: newId(), name: worldName(copy, behaviors), day: extras.day, scene: copy };
  if (extras.seed !== undefined) snapshot.seed = extras.seed;
  if (extras.theme) snapshot.theme = extras.theme;
  return snapshot;
}

/**
 * The same sheets holding `total` particles between them, each sheet keeping its share.
 * The scene itself comes back when it already holds that many, or when either count is unknown.
 */
export function withParticleTotal(scene: Scene, total: number): Scene {
  const held = scene.planes.reduce((n, p) => n + p.particleCount, 0);
  if (!(total > 0) || !(held > 0) || held === total) return scene;
  const factor = total / held;
  return { ...scene, planes: scene.planes.map((p) => ({ ...p, particleCount: Math.max(1, Math.round(p.particleCount * factor)) })) };
}

/** A deep copy with only the contract's fields, dropping anything a caller may have hung on the objects. */
export function cloneScene(scene: Scene): Scene {
  return {
    version: 1,
    ...(scene.name === undefined ? {} : { name: scene.name }),
    seed: scene.seed,
    planes: scene.planes.map((p) => {
      const plane: PlaneDesc = {
        position: [p.position[0], p.position[1], p.position[2]],
        rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]],
        halfSize: [p.halfSize[0], p.halfSize[1]],
        behaviorId: p.behaviorId,
        particleCount: p.particleCount,
        seed: p.seed,
      };
      if (p.id !== undefined) plane.id = p.id;
      if (p.params) plane.params = { ...p.params };
      // brightness is left out on purpose: streaming fades planes with it, and a kept plane is fully lit.
      return plane;
    }),
    camera: {
      target: [scene.camera.target[0], scene.camera.target[1], scene.camera.target[2]],
      yaw: scene.camera.yaw,
      pitch: scene.camera.pitch,
      distance: scene.camera.distance,
      fovY: scene.camera.fovY,
    },
    render: { brightness: scene.render.brightness },
  };
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nums = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(num);

/** True when stored JSON has the shape of a Scene the engine can load. Stored data can be old, cut short or edited by hand. */
export function isScene(v: unknown): v is Scene {
  const s = v as Scene | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.planes) || !s.camera || !s.render) return false;
  const c = s.camera;
  if (!nums(c.target, 3) || !num(c.yaw) || !num(c.pitch) || !num(c.distance) || !num(c.fovY)) return false;
  if (!num(s.render.brightness)) return false;
  return s.planes.every(
    (p) =>
      p &&
      typeof p === "object" &&
      typeof p.behaviorId === "string" &&
      nums(p.position, 3) &&
      nums(p.rotation, 4) &&
      nums(p.halfSize, 2) &&
      num(p.particleCount) &&
      p.particleCount >= 1 &&
      num(p.seed) &&
      (p.params === undefined || (typeof p.params === "object" && p.params !== null && Object.values(p.params).every(num))),
  );
}

/** True when stored JSON has the shape of a Snapshot. */
export function isSnapshot(v: unknown): v is Snapshot {
  const s = v as Snapshot | null;
  return (
    !!s &&
    typeof s === "object" &&
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.day === "string" &&
    (s.seed === undefined || num(s.seed)) &&
    (s.theme === undefined || typeof s.theme === "string") &&
    isScene(s.scene)
  );
}
