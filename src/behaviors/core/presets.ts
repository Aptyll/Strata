/**
 * Presets: a named set of param values for one behavior. Plain JSON, so they can be
 * saved, shared as a short string, randomized and blended.
 */
import type { Behavior } from "../../core/contracts";
import { diffParams, lerpParams, randomizeParams, resolveParams, type ParamValues, type RandomizeOptions } from "./params";

export interface BehaviorPreset {
  name: string;
  behaviorId: string;
  /** Overrides of the behavior's defaults. Assign to PlaneDesc.params to apply. */
  params: ParamValues;
}

export function makePreset(behavior: Behavior, name: string, values?: ParamValues): BehaviorPreset {
  return { name, behaviorId: behavior.id, params: diffParams(behavior, resolveParams(behavior, values)) };
}

export function randomPreset(behavior: Behavior, options: RandomizeOptions = {}): BehaviorPreset {
  const seed = options.seed ?? 1;
  return makePreset(behavior, `${behavior.label ?? behavior.id} #${seed}`, randomizeParams(behavior, { ...options, seed }));
}

/**
 * Blend two presets of the same behavior. Presets of different behaviors run different
 * shaders and cannot be blended by value; cross-fade two planes instead.
 */
export function blendPresets(behavior: Behavior, a: BehaviorPreset, b: BehaviorPreset, t: number): BehaviorPreset {
  if (a.behaviorId !== behavior.id || b.behaviorId !== behavior.id) {
    throw new Error(`blendPresets needs two presets of "${behavior.id}"`);
  }
  return makePreset(behavior, t < 0.5 ? a.name : b.name, lerpParams(behavior, a.params, b.params, t));
}

function round(v: number): string {
  return String(Number(v.toPrecision(6)));
}

/** Short, readable share string, for example `flow-field?scale=2.5&speed=0.3#Slow%20drift`. */
export function encodePreset(preset: BehaviorPreset): string {
  const query = Object.entries(preset.params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${round(v)}`)
    .join("&");
  return `${preset.behaviorId}${query ? `?${query}` : ""}${preset.name ? `#${encodeURIComponent(preset.name)}` : ""}`;
}

/**
 * Parse a share string. Values are clamped to the behavior's ranges and unknown params
 * are dropped, so a string from an older version still loads. Returns null when the
 * behavior is unknown or the text is malformed.
 */
export function decodePreset(text: string, behaviors: readonly Behavior[]): BehaviorPreset | null {
  try {
    const [head, fragment = ""] = text.trim().split("#", 2);
    const [id, query = ""] = head.split("?", 2);
    const behavior = behaviors.find((b) => b.id === id);
    if (!behavior) return null;
    const values: ParamValues = {};
    for (const pair of query.split("&")) {
      if (!pair) continue;
      const [k, v] = pair.split("=", 2);
      const n = Number(v);
      if (Number.isFinite(n)) values[decodeURIComponent(k)] = n;
    }
    return makePreset(behavior, decodeURIComponent(fragment) || behavior.label || behavior.id, values);
  } catch {
    return null;
  }
}
