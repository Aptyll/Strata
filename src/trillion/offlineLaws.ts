// The offline renderer's laws (src/offline/core/laws.ts) as TrillionKernel
// laws, so the kernel can stand in behind StatelessRenderer unchanged.

import { WGSL_LAWS } from '../offline/core/laws';
import type { TrillionLaw } from './kernel';

export const OFFLINE_LAWS: readonly TrillionLaw[] = [
  { id: 'kepler', fn: 'lawKepler', wgsl: WGSL_LAWS },
  { id: 'vortex', fn: 'lawVortex', wgsl: WGSL_LAWS },
  { id: 'lissajous', fn: 'lawLissajous', wgsl: WGSL_LAWS },
];

/**
 * The same laws with their two main uniform draws taken from the stratified
 * coordinate instead of the key, so they run on the strata path. Same
 * distribution of positions per plane, but neighbouring ids land close
 * together. kepler: radius and phase; vortex: band and height; lissajous:
 * phase along the figure and shell. If the offline WGSL changes so that a
 * draw is no longer found, that law falls back to the plain path.
 */
const STRAT_DRAWS: Record<string, [string, string][]> = {
  kepler: [['u01(draw(key, 0u))', 'strat(key).x'], ['u01(draw(key, 1u))', 'strat(key).y']],
  vortex: [['u01(draw(key, 0u))', 'strat(key).x'], ['u01(draw(key, 2u))', 'strat(key).y']],
  lissajous: [['u01(draw(key, 0u))', 'strat(key).x'], ['u01(draw(key, 1u))', 'strat(key).y']],
};

function stratified(law: TrillionLaw): TrillionLaw {
  // Rewrite only this law's function body.
  const head = `fn ${law.fn}(`;
  const at = law.wgsl.indexOf(head);
  const next = law.wgsl.indexOf('\nfn ', at + head.length);
  if (at < 0) return law;
  const end = next < 0 ? law.wgsl.length : next;
  let body = law.wgsl.slice(at, end);
  for (const [from, to] of STRAT_DRAWS[law.id] ?? []) {
    if (!body.includes(from)) {
      console.warn(`trillion: ${law.id} no longer uses ${from}; it stays on the plain path`);
      return law;
    }
    body = body.split(from).join(to);
  }
  return { ...law, wgsl: law.wgsl.slice(0, at) + body + law.wgsl.slice(end), coherent: true };
}

export const STRATIFIED_OFFLINE_LAWS: readonly TrillionLaw[] = OFFLINE_LAWS.map(stratified);
