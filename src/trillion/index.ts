// Trillion particle splat kernel. See docs/trillion.md.
export { TrillionKernel, planeHomography, trillionLimits } from './kernel';
export type { TrillionLaw, TrillionPlane, TrillionBatch, TrillionKernelOptions, TrillionFrameSettings, TrillionTally, PixelRect } from './kernel';
export { renderFrame } from './driver';
export type { FrameOptions } from './driver';
export { LAW_PRELUDE, splatWgsl, FOLD_WGSL } from './wgsl';
export { ORBIT_LAW, LISSAJOUS_LAW, STANDIN_LAWS } from './laws';
export { OFFLINE_LAWS, STRATIFIED_OFFLINE_LAWS } from './offlineLaws';
