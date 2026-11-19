/**
 * Live capture controller: hotkeys for screenshots and realtime recording.
 *
 * Captures have to happen right after the engine draws, so key presses only
 * set a flag; the actual capture runs inside `afterRender()`, which the
 * engine calls at the end of every frame.
 */
import { type FrameImage, type Recorder, type RecordingOptions, type RecordingResult, startRecording } from './recorder';
import { capturePNG } from './still';
import { type AnyCanvas, cssFilterOf, downloadBlob, timestampName } from './util';

export interface CaptureControllerOptions {
  /** Key that saves a PNG. Default 'p'. Null disables. */
  screenshotKey?: string | null;
  /** Key that starts and stops recording. Default 'r'. Null disables. */
  recordKey?: string | null;
  /** Settings for live recordings. `timing` defaults to 'realtime'. */
  recording?: RecordingOptions;
  /** Prefix for downloaded files. Default 'strata'. */
  filePrefix?: string;
  /** Called with short human readable status text, for an on-screen indicator. */
  onStatus?: (status: string) => void;
  /** Called with each finished file. Default: download it. */
  onFile?: (blob: Blob, filename: string) => void;
  /**
   * Supplies the frame just rendered instead of reading the canvas (see
   * TextureReader). Called from `afterRender`.
   */
  capture?: () => FrameImage | Promise<FrameImage>;
  /** Element that listens for the hotkeys. Default window. */
  keyTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface CaptureController {
  /** Call once per frame, immediately after the engine has drawn to the canvas. */
  afterRender(): void;
  /** Saves a PNG of the next rendered frame. */
  requestScreenshot(): void;
  startRecording(): Promise<void>;
  stopRecording(): Promise<RecordingResult | null>;
  toggleRecording(): Promise<void>;
  readonly recording: boolean;
  /** Removes the key listeners and cancels any recording in progress. */
  dispose(): void;
}

export function createCaptureController(
  canvas: AnyCanvas,
  opts: CaptureControllerOptions = {},
): CaptureController {
  const prefix = opts.filePrefix ?? 'strata';
  const status = opts.onStatus ?? (() => {});
  const deliver = opts.onFile ?? downloadBlob;
  const keyTarget = opts.keyTarget ?? window;
  const screenshotKey = opts.screenshotKey === undefined ? 'p' : opts.screenshotKey;
  const recordKey = opts.recordKey === undefined ? 'r' : opts.recordKey;

  let screenshotPending = false;
  let recorder: Recorder | null = null;
  let transitioning = false;

  const controller: CaptureController = {
    afterRender() {
      if (screenshotPending) {
        screenshotPending = false;
        const name = timestampName(prefix, 'png');
        // Taken from the canvas element even when `capture` supplies the pixels.
        const filter = cssFilterOf(canvas);
        Promise.resolve(opts.capture ? opts.capture() : canvas)
          .then((image) => capturePNG(image, { filter }))
          .then(
            (blob) => {
              deliver(blob, name);
              status(`Saved ${name}`);
            },
            (err) => status(`Screenshot failed: ${err.message ?? err}`),
          );
      }
      if (recorder?.active) {
        const rec = recorder;
        const added = opts.capture
          ? Promise.resolve(opts.capture()).then((image) => rec.addFrame(image))
          : rec.addFrame();
        added.catch((err) => {
          if (recorder === rec) {
            recorder = null;
            void rec.cancel().catch(() => {});
            status(`Recording failed: ${err.message ?? err}`);
          }
        });
      }
    },

    requestScreenshot() {
      screenshotPending = true;
    },

    async startRecording() {
      if (recorder || transitioning) return;
      transitioning = true;
      try {
        recorder = await startRecording(canvas, { timing: 'realtime', ...opts.recording });
        status(`Recording ${recorder.width}x${recorder.height} ${recorder.codec}`);
      } catch (err) {
        status(`Could not start recording: ${(err as Error).message ?? err}`);
        throw err;
      } finally {
        transitioning = false;
      }
    },

    async stopRecording() {
      if (!recorder || transitioning) return null;
      transitioning = true;
      const rec = recorder;
      recorder = null;
      try {
        status('Finishing video');
        const result = await rec.stop();
        if (result.blob) {
          const name = timestampName(prefix, 'mp4');
          deliver(result.blob, name);
          status(`Saved ${name} (${result.duration.toFixed(1)} s)`);
        } else {
          status(`Saved video (${result.duration.toFixed(1)} s)`);
        }
        return result;
      } finally {
        transitioning = false;
      }
    },

    async toggleRecording() {
      if (recorder) await controller.stopRecording();
      else await controller.startRecording();
    },

    get recording() {
      return !!recorder?.active;
    },

    dispose() {
      keyTarget.removeEventListener('keydown', onKey as EventListener);
      void recorder?.cancel().catch(() => {});
      recorder = null;
    },
  };

  function onKey(e: KeyboardEvent) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''))) return;
    const key = e.key.toLowerCase();
    if (screenshotKey && key === screenshotKey.toLowerCase()) {
      controller.requestScreenshot();
    } else if (recordKey && key === recordKey.toLowerCase()) {
      void controller.toggleRecording().catch(() => {});
    }
  }
  keyTarget.addEventListener('keydown', onKey as EventListener);

  return controller;
}
