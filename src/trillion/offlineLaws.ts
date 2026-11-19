// The offline renderer's laws (src/offline/core/laws.ts) as TrillionKernel
// laws, so the kernel can stand in behind StatelessRenderer unchanged.

import { WGSL_LAWS } from '../offline/core/laws';
import type { TrillionLaw } from './kernel';

export const OFFLINE_LAWS: readonly TrillionLaw[] = [
  { id: 'kepler', fn: 'lawKepler', wgsl: WGSL_LAWS },
  { id: 'vortex', fn: 'lawVortex', wgsl: WGSL_LAWS },
  { id: 'lissajous', fn: 'lawLissajous', wgsl: WGSL_LAWS },
];
