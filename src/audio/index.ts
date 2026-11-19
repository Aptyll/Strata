/**
 * Strata sound: a restrained generative soundtrack driven by the scene, live
 * in the app (off by default) and rendered offline in step with video frames.
 * See docs/audio.md.
 */
export { mountSound } from "./app";
export type { FrameTick, MountedSound, SoundHost, SoundHud } from "./app";

export { createSoundtrack } from "./live";
export type { Soundtrack, SoundtrackOptions } from "./live";

export { Composer } from "./composer";
export type { ComposerOptions, ComposerSink } from "./composer";

export { SoundPerformance, compose } from "./performance";
export type { PerformanceOptions } from "./performance";

export {
  renderRange,
  renderPerformance,
  renderScore,
  createRecordingAudio,
  DEFAULT_SAMPLE_RATE,
  PREROLL,
} from "./offline";
export type { RenderOptions, FullRenderOptions, RecordingAudioOptions, SoundtrackRecording } from "./offline";

export { scoreFromTimeline, ladderScore } from "./timeline";
export type { Timeline, LadderOptions } from "./timeline";

export { senseScene, densityOf } from "./sense";
export { encodeWav } from "./wav";
export type { WavOptions } from "./wav";
export { measureLoudness, normalizeLoudness } from "./loudness";
export type { Loudness } from "./loudness";
export { CHORDS, ROOT_HZ } from "./harmony";

export type { SoundFrame, SoundEvent, SoundScore, ScoreEvent, Note, Segment, ControlFrame, RecordingAudio } from "./types";
export { VOICES } from "./types";
