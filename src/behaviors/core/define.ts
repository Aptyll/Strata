/**
 * Authoring helpers: define a behavior with rich param specs, and check that a behavior
 * fits the engine contract before it reaches the GPU.
 */
import { MAX_BEHAVIOR_PARAMS, type Behavior } from "../../core/contracts";
import type { RichParamSpec } from "./params";

export interface BehaviorDef extends Omit<Behavior, "params"> {
  /** One or two sentences for the behavior browser. */
  description?: string;
  /** Free-form labels for filtering, for example "flow", "orbit". */
  tags?: string[];
  params: Record<string, RichParamSpec>;
}

/** A Behavior that also carries the optional UI metadata. */
export type RichBehavior = Behavior & Pick<BehaviorDef, "description" | "tags"> & { params: Record<string, RichParamSpec> };

const WGSL_IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Problems that would break the engine contract. An empty list means the behavior is fine. */
export function validateBehavior(behavior: Behavior): string[] {
  const issues: string[] = [];
  if (!KEBAB.test(behavior.id)) issues.push(`id "${behavior.id}" must be kebab-case`);
  const names = Object.keys(behavior.params);
  if (names.length > MAX_BEHAVIOR_PARAMS) {
    issues.push(`${names.length} params declared, the uniform block holds ${MAX_BEHAVIOR_PARAMS}`);
  }
  for (const name of names) {
    const spec: RichParamSpec = behavior.params[name];
    const at = `param "${name}"`;
    if (!WGSL_IDENT.test(name) || name.startsWith("__")) issues.push(`${at} is not a valid WGSL field name`);
    if (![spec.default, spec.min, spec.max].every(Number.isFinite)) issues.push(`${at} needs finite default, min and max`);
    if (spec.min > spec.max) issues.push(`${at} has min > max`);
    if (spec.default < spec.min || spec.default > spec.max) issues.push(`${at} default is outside min..max`);
    if (spec.scale === "log" && spec.min <= 0) issues.push(`${at} uses a log scale, so min must be above 0`);
    if (spec.randomRange && (spec.randomRange[0] < spec.min || spec.randomRange[1] > spec.max || spec.randomRange[0] > spec.randomRange[1])) {
      issues.push(`${at} randomRange must lie inside min..max`);
    }
  }
  if (!/\bfn\s+update\s*\(/.test(behavior.wgsl)) issues.push("wgsl must define fn update(p: Particle, i: u32) -> Particle");
  // A param the WGSL reads but does not declare is a typo the WGSL compiler would only report at runtime.
  for (const m of behavior.wgsl.matchAll(/\bplane\.params\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!(m[1] in behavior.params)) issues.push(`wgsl reads plane.params.${m[1]}, which is not declared`);
  }
  return [...new Set(issues)];
}

/**
 * Identity helper for behavior files. It gives type checking for the rich param fields
 * and throws at load time (not on the GPU) when the behavior breaks the contract.
 */
export function defineBehavior(def: BehaviorDef): RichBehavior {
  const issues = validateBehavior(def);
  if (issues.length) throw new Error(`Behavior "${def.id}": ${issues.join("; ")}`);
  return def;
}
