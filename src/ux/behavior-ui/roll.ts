/**
 * What a press of the dice produces.
 *
 *   rollScene   pure: current scene + registered behaviors + seed -> a new scene
 *   startRoll   applies a rolled scene to the running app as smoothly as the
 *               engine allows, driven by update(dt) once per frame
 *
 * Costs nothing on the GPU and allocates only on a press, so it stays out of
 * the way of the particle-count work. Design notes: docs/ux/behavior-ui.md.
 */
import type { AppContext, Behavior, ParamSpec, PlaneDesc, PlaneInstance, Scene } from "../../core/contracts";

/** Per behavior id, per param name: the [low, high] a roll may pick from. */
export type RollRanges = Record<string, Record<string, [number, number]>>;

export interface RollOptions {
  /**
   * How far a roll may stray from a param's default, as a fraction of its full
   * range on each side. Defaults are the values a behavior's author tuned, so
   * staying near them is what keeps rolls from coming out dead or chaotic.
   * 0 always gives defaults, 1 samples the whole range. Default 0.3.
   */
  spread?: number;
  /** Hand-tuned ranges that replace `spread` for the params they name. */
  ranges?: RollRanges;
  /** A world is built from 1..maxVoices distinct behaviors. Default 3. */
  maxVoices?: number;
  /** How much planes sharing a voice differ from each other, fraction of range. Default 0.05. */
  variation?: number;
  /** Behavior ids the dice should never pick. */
  exclude?: readonly string[];
}

/** Small seeded generator (mulberry32). Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function snap(spec: ParamSpec, v: number): number {
  if (spec.step && spec.step > 0) v = spec.min + Math.round((v - spec.min) / spec.step) * spec.step;
  return clamp(v, spec.min, spec.max);
}

/** The window of a param a roll may land in. */
function window(behaviorId: string, name: string, spec: ParamSpec, opts: RollOptions): [number, number] {
  const tuned = opts.ranges?.[behaviorId]?.[name];
  if (tuned) return [clamp(Math.min(tuned[0], tuned[1]), spec.min, spec.max), clamp(Math.max(tuned[0], tuned[1]), spec.min, spec.max)];
  const reach = (opts.spread ?? 0.3) * (spec.max - spec.min);
  return [Math.max(spec.min, spec.default - reach), Math.min(spec.max, spec.default + reach)];
}

/** One set of params for a behavior, inside its known-good windows. */
export function rollParams(behavior: Behavior, random: () => number, opts: RollOptions = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, spec] of Object.entries(behavior.params)) {
    const [lo, hi] = window(behavior.id, name, spec, opts);
    out[name] = snap(spec, lo + (hi - lo) * random());
  }
  return out;
}

/** A close relative of `params`: each value nudged, still inside its window. */
function vary(behavior: Behavior, params: Record<string, number>, random: () => number, opts: RollOptions): Record<string, number> {
  const amount = opts.variation ?? 0.05;
  const out: Record<string, number> = {};
  for (const [name, spec] of Object.entries(behavior.params)) {
    const [lo, hi] = window(behavior.id, name, spec, opts);
    const nudged = params[name] + (random() * 2 - 1) * amount * (spec.max - spec.min);
    out[name] = snap(spec, clamp(nudged, lo, hi));
  }
  return out;
}

/**
 * Roll a new world. Planes keep their transforms, sizes and particle counts,
 * and the camera and render settings are untouched: only what the particles do
 * changes.
 *
 * A world is not N independent rolls, which reads as noise. Instead 1 to 3
 * "voices" (distinct behaviors with rolled params) are chosen and each plane is
 * a close variation of a voice, laid out in runs so neighbours relate.
 *
 * Same scene, behaviors and seed always give the same result.
 */
export function rollScene(scene: Scene, behaviors: readonly Behavior[], seed: number, opts: RollOptions = {}): Scene {
  const pool = behaviors.filter((b) => !opts.exclude?.includes(b.id));
  if (pool.length === 0 || scene.planes.length === 0) return scene;
  const random = seededRandom(seed);

  // Shuffle, then make sure the first voice is a change from what plane 0 shows now.
  const order = pool.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (order.length > 1 && order[0].id === scene.planes[0].behaviorId) [order[0], order[1]] = [order[1], order[0]];

  const voiceCount = Math.min(order.length, scene.planes.length, 1 + Math.floor(random() * (opts.maxVoices ?? 3)));
  const voices = order.slice(0, voiceCount).map((behavior) => ({ behavior, params: rollParams(behavior, random, opts) }));
  const repeats = 1 + Math.floor(random() * 2);
  const run = Math.max(1, Math.round(scene.planes.length / (voiceCount * repeats)));

  const planes = scene.planes.map((plane, i): PlaneDesc => {
    const voice = voices[Math.floor(i / run) % voiceCount];
    const same = voice.behavior.id === plane.behaviorId;
    return {
      ...plane,
      behaviorId: voice.behavior.id,
      params: vary(voice.behavior, voice.params, random, opts),
      // A plane that keeps its behavior keeps its seed, so its params can glide with no jump.
      seed: same ? plane.seed : random(),
    };
  });
  return { ...scene, seed, planes };
}

export interface RollTransitionOptions {
  /** Seconds each plane takes to arrive. Default 2.4. */
  duration?: number;
  /** Seconds between one plane starting and the next, so the change sweeps through the stack. Default 0.1. */
  stagger?: number;
  /**
   * Swap a live plane's behavior while keeping its particles where they are.
   * The shared contracts do not offer this yet. When supplied, each plane
   * switches at its turn in the sweep and its particles simply start obeying
   * the new rule from wherever they were, which is the smooth path. Without it,
   * planes whose behavior changes go through one AppContext.loadScene.
   */
  swapBehavior?: (plane: PlaneInstance, target: PlaneDesc) => void;
}

export interface RollTransition {
  /** Call once per frame. Returns true when the roll has fully landed. */
  update(dt: number): boolean;
  readonly done: boolean;
}

const ease = (u: number) => u * u * (3 - 2 * u);

function effectiveParams(behavior: Behavior, desc: PlaneDesc): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, spec] of Object.entries(behavior.params)) out[name] = desc.params?.[name] ?? spec.default;
  return out;
}

/**
 * Move the running world to `target` (normally the result of rollScene on
 * app.getScene()).
 *
 * Planes that keep their behavior glide: params are interpolated every frame
 * and pushed with app.updatePlane, a few floats per plane.
 * Planes that change behavior use `swapBehavior` when given, else a single
 * loadScene at the start.
 *
 * Starting a new roll while one is in flight is fine: drop the old transition
 * and start another, it picks up from whatever the planes hold at that moment.
 */
export function startRoll(app: AppContext, target: Scene, opts: RollTransitionOptions = {}): RollTransition {
  const duration = Math.max(0.001, opts.duration ?? 2.4);
  const stagger = Math.max(0, opts.stagger ?? 0.1);
  const current = app.getScene();
  const comparable = current.planes.length === target.planes.length && app.planes.length === target.planes.length;
  const changes = (i: number) => current.planes[i].behaviorId !== target.planes[i].behaviorId;
  const from = comparable ? app.planes.map((p) => effectiveParams(p.behavior, p.desc)) : [];

  if (!comparable) {
    app.loadScene(target);
  } else if (!opts.swapBehavior && target.planes.some((_, i) => changes(i))) {
    // Changed planes cut over now; kept planes are loaded at their current values and glide from there.
    app.loadScene({ ...target, planes: target.planes.map((p, i) => (changes(i) ? p : { ...p, params: from[i] })) });
  }

  const swapped = new Set<number>();
  let time = 0;
  let done = !comparable;
  return {
    get done() {
      return done;
    },
    update(dt: number): boolean {
      if (done) return true;
      time += dt;
      let landed = 0;
      app.planes.forEach((plane, i) => {
        const goal = target.planes[i];
        const u = clamp((time - i * stagger) / duration, 0, 1);
        if (changes(i)) {
          if (opts.swapBehavior && u > 0 && !swapped.has(i)) {
            swapped.add(i);
            opts.swapBehavior(plane, goal);
          }
          if (!opts.swapBehavior || u > 0) landed++;
          return;
        }
        const k = ease(u);
        const params: Record<string, number> = {};
        for (const name of Object.keys(plane.behavior.params)) {
          const a = from[i][name];
          const b = goal.params?.[name] ?? plane.behavior.params[name].default;
          params[name] = u >= 1 ? b : a + (b - a) * k;
        }
        plane.desc.params = params;
        app.updatePlane(plane);
        if (u >= 1) landed++;
      });
      done = landed === app.planes.length;
      return done;
    },
  };
}
