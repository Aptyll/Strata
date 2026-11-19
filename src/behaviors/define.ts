import { MAX_BEHAVIOR_PARAMS, type Behavior } from "../core/contracts";

/** Identity helper that type-checks a behavior and validates its param count. */
export function defineBehavior(b: Behavior): Behavior {
  const n = Object.keys(b.params).length;
  if (n > MAX_BEHAVIOR_PARAMS) {
    throw new Error(`Behavior "${b.id}" has ${n} params, max is ${MAX_BEHAVIOR_PARAMS}`);
  }
  return b;
}
