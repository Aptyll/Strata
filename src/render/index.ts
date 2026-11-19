// src/render: particles to a monochrome picture, through a float density
// buffer. See docs/render.md.
//
// Which piece to use:
//   inside the engine frame graph      createDensityTonemapPass, createDensitySplatPass (passes.ts)
//   a float density texture already    DensityPost (trails, bloom, tone map)
//   integer hit counters (atomicAdd)   CountToneMapper (counters -> density -> DensityPost)
//   only particle buffers              DensityRenderer (SplatAccumulator + DensityPost)
//   particles into your own target     SplatAccumulator

export { DensityRenderer, type DensityRendererOptions } from './pipeline';
export { DensityPost, DEFAULT_SETTINGS, type DensitySettings, type DensityPostOptions } from './post';
export { SplatAccumulator, type SplatBatch, type SplatMode, type SplatTarget } from './splat';
export { Trails, TRAIL_MODES, type TrailMode, type TrailOptions } from './trails';
export { Bloom } from './bloom';
export { ToneMap, DEFAULT_TONE, type ToneSettings } from './tonemap';
export {
  CountToneMapper,
  exposureFromHistogram,
  histogramPercentile,
  type CountHistogram,
  type CountToneMapperOptions,
  type AutoExposeOptions,
} from './counts';
export { CURVES, DISPLAYS, pickHdrFormat, type Curve, type Display } from './common';
export {
  createDensityTonemapPass,
  createDensitySplatPass,
  planeModelMatrix,
  mulMat4,
  type DensityTonemapPassOptions,
  type DensitySplatPassOptions,
} from './passes';
