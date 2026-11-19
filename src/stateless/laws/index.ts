import { STATELESS_RNG_WGSL } from '../rng';
import { galaxy } from './galaxy';
import { ribbons } from './ribbons';
import type { StatelessLaw } from './types';
import { veil } from './veil';
import { web } from './web';

export { galaxy, ribbons, veil, web };
export { defineLaw } from './types';
export type { LawCost, LawParam, LawSpec, Q, StatelessLaw } from './types';

/** Every law, cheapest first. */
export const STATELESS_LAWS: readonly StatelessLaw[] = [veil, galaxy, web, ribbons];

export function lawById(id: string): StatelessLaw | undefined {
  return STATELESS_LAWS.find((law) => law.id === id);
}

/**
 * WGSL for a set of laws, without the prelude. Each law's source is
 * self-contained apart from `STATELESS_RNG_WGSL`, and names do not collide, so
 * any subset can share one module.
 */
export function lawsWgsl(laws: readonly StatelessLaw[] = STATELESS_LAWS): string {
  return laws.map((law) => law.wgsl).join('\n');
}

/** Prelude plus laws: a complete module apart from the caller's entry point. */
export function lawModuleWgsl(laws: readonly StatelessLaw[] = STATELESS_LAWS): string {
  return `${STATELESS_RNG_WGSL}\n${lawsWgsl(laws)}`;
}

/**
 * A law in the shape of a trillion kernel law (`TrillionLaw` in src/trillion)
 * for its strata path: q.x and q.y come from the kernel's stratified
 * coordinate `strat(key)` instead of the key, so neighbouring ids land near
 * each other and their hits merge before any global atomic. On the kernel's
 * other entry points `strat(key)` is (u01(key.x), u01(key.y)), which makes
 * `<fn>Strat` the same function as `law.fn`. The WGSL only compiles where
 * `strat` is defined, that is inside the trillion kernel.
 *
 * `coherent` passes the law's own flag through: a law that takes choices from
 * q.z would scatter a strata walk, so the kernel should keep it on the plain
 * path (where `law` itself, which already has `id`, `fn` and `wgsl`, works).
 */
export function strataVariant(law: StatelessLaw): { id: string; fn: string; wgsl: string; coherent: boolean } {
  const fn = `${law.fn}Strat`;
  const wgsl = `${law.wgsl}
fn ${fn}(key: Key, t: f32, p: array<f32, 8>) -> vec2f {
  let s = strat(key);
  return ${law.qFn}(vec3f(s.x, s.y, u01(draw(key, 2u))), t, p);
}
`;
  return { id: law.id, fn, wgsl, coherent: law.coherent };
}
