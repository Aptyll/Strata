/**
 * Strata capture: PNG stills and MP4 video straight from the canvas.
 * See docs/capture.md.
 */
export { capturePNG, captureStillPNG, captureTiledPNG, computeTiles } from './still';
export type { StillOptions, SupersampledStillOptions, TiledStillOptions, Tile, CaptureHook } from './still';

export { startRecording, isRecordingSupported, pickOutputFile } from './recorder';
export type {
  Recorder,
  RecordingOptions,
  RecordingResult,
  RecordingAudio,
  CaptureCodec,
  CaptureAudioCodec,
  FrameImage,
} from './recorder';

export { TextureReader } from './gpuReadback';
export type { PendingRead } from './gpuReadback';

export { renderOffline } from './offline';
export type { OfflineRenderOptions, OfflineProgress, OfflineFrame } from './offline';

export { keyframePath, statePath, orbitPath, sequencePath, functionPath, viewMatrix } from './cameraPath';
export type {
  CameraPath,
  CameraPose,
  CameraKeyframe,
  NumericState,
  KeyframePathOptions,
  OrbitPathOptions,
  Easing,
  Vec3,
} from './cameraPath';

export { createCaptureController } from './controller';
export type { CaptureController, CaptureControllerOptions } from './controller';

export { downloadBlob, timestampName } from './util';

export { createCapturePass } from './capturePass';
export type { CapturePass } from './capturePass';
