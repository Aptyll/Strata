/**
 * Deterministic offline rendering: the simulation is advanced by exactly
 * 1 / fps per video frame and every frame is encoded, however long it takes
 * to render. A scene that only manages 5 fps live still comes out as a
 * perfectly smooth 4K60 file.
 */
import type { CameraPath, CameraPose } from './cameraPath';
import { type FrameImage, type Recorder, type RecordingOptions, type RecordingResult, startRecording } from './recorder';
import { type AnyCanvas, setCanvasSize, yieldToEventLoop } from './util';

export interface OfflineFrame {
  /** Index of the video frame being produced, starting at 0. */
  frame: number;
  totalFrames: number;
  /** Video time of this frame in seconds (frame / fps). */
  time: number;
  /** Simulation time step for one `step` call, in seconds. */
  dt: number;
  /** 0 to 1. */
  progress: number;
}

export interface OfflineProgress extends OfflineFrame {
  /** Wall clock seconds since the render started. */
  elapsed: number;
  /** Estimated wall clock seconds remaining. */
  remaining: number;
  /** Video frames rendered per wall clock second. */
  renderFps: number;
}

export interface OfflineRenderOptions<TPose = CameraPose> {
  canvas: AnyCanvas;
  /** Output frame rate. Default 60. */
  fps?: number;
  /** Length of the video in seconds. Give this or `frames`. */
  duration?: number;
  /** Length of the video in frames. */
  frames?: number;
  /** Output width in pixels. Default: current canvas width. */
  width?: number;
  /** Output height in pixels. Default: current canvas height. */
  height?: number;
  /**
   * Render each frame at this multiple of the output size per axis and box
   * filter it down, for cleaner sub-pixel particles. Default 1.
   */
  supersample?: number;
  /** Simulation steps per video frame, each of `1 / (fps * substeps)` seconds. Default 1. */
  substeps?: number;
  /** Simulation steps to run before the first captured frame (not recorded). Default 0. */
  warmupSteps?: number;
  /**
   * Advances the simulation by `ctx.dt` seconds. Use the dt given here, never
   * the wall clock, or the result will not be deterministic.
   */
  step: (dt: number, ctx: OfflineFrame) => void;
  /**
   * Draws the current state into the canvas. Must draw synchronously: the
   * canvas is captured as soon as this returns.
   */
  render: (ctx: OfflineFrame) => void;
  /**
   * Optional: supplies the image for each frame instead of reading the
   * canvas, for example a VideoFrame from {@link TextureReader}. Called right
   * after `render`. Because it may be async, it also works for pipelines
   * whose result is not on the canvas when `render` returns.
   */
  capture?: (ctx: OfflineFrame) => FrameImage | Promise<FrameImage>;
  /**
   * Optional: awaited after each frame is captured. Return
   * `device.queue.onSubmittedWorkDone()` here so the loop does not queue up
   * GPU work faster than the GPU can execute it.
   */
  flush?: () => Promise<unknown>;
  /** Optional scripted camera, sampled at each frame's video time. */
  camera?: CameraPath<TPose>;
  /** Receives the camera pose for each frame, before `render`. */
  applyCamera?: (pose: TPose, ctx: OfflineFrame) => void;
  /** Encoder settings. `fps`, `width`, `height` and `timing` are set for you. */
  recording?: Omit<RecordingOptions, 'fps' | 'width' | 'height' | 'timing'>;
  onProgress?: (p: OfflineProgress) => void;
  /** Abort to cancel the render and discard the file. */
  signal?: AbortSignal;
}

/**
 * Renders a video offline at a fixed time step and returns the finished MP4.
 * The canvas backing store is resized for the duration and restored after.
 */
export async function renderOffline<TPose = CameraPose>(
  opts: OfflineRenderOptions<TPose>,
): Promise<RecordingResult> {
  const { canvas } = opts;
  const fps = opts.fps ?? 60;
  const totalFrames = Math.round(opts.frames ?? (opts.duration ?? opts.camera?.duration ?? 0) * fps);
  if (!(totalFrames > 0)) throw new RangeError('capture: renderOffline needs a duration or frame count.');
  const width = Math.floor((opts.width ?? canvas.width) / 2) * 2;
  const height = Math.floor((opts.height ?? canvas.height) / 2) * 2;
  const ss = opts.supersample ?? 1;
  const substeps = Math.max(1, Math.round(opts.substeps ?? 1));
  const dt = 1 / (fps * substeps);

  const prevW = canvas.width;
  const prevH = canvas.height;
  setCanvasSize(canvas, Math.round(width * ss), Math.round(height * ss));

  // A failing flush only costs pacing, so it must not abort a long render.
  let flush = opts.flush;
  const pace = async () => {
    if (!flush) return;
    try {
      await flush();
    } catch (err) {
      console.warn('capture: flush() failed, continuing without GPU pacing.', err);
      flush = undefined;
    }
  };

  let recorder: Recorder | null = null;
  try {
    recorder = await startRecording(canvas, { ...opts.recording, fps, width, height, timing: 'fixed' });
    const ctx: OfflineFrame = { frame: 0, totalFrames, time: 0, dt, progress: 0 };

    for (let i = 0; i < (opts.warmupSteps ?? 0); i++) {
      opts.step(dt, ctx);
      if (i % 16 === 15) {
        await pace();
        await yieldToEventLoop();
        opts.signal?.throwIfAborted();
      }
    }

    const startedAt = performance.now();
    let lastYield = startedAt;
    for (let frame = 0; frame < totalFrames; frame++) {
      opts.signal?.throwIfAborted();
      ctx.frame = frame;
      ctx.time = frame / fps;
      ctx.progress = frame / totalFrames;

      // Frame 0 shows the initial state; each later frame is one step ahead.
      if (frame > 0) for (let s = 0; s < substeps; s++) opts.step(dt, ctx);
      if (opts.camera && opts.applyCamera) opts.applyCamera(opts.camera.sample(ctx.time), ctx);
      opts.render(ctx);
      // The canvas is copied synchronously inside addFrame, before any await.
      if (opts.capture) await recorder.addFrame(await opts.capture(ctx));
      else await recorder.addFrame();
      await pace();

      const now = performance.now();
      if (now - lastYield > 50 || frame === totalFrames - 1) {
        const elapsed = (now - startedAt) / 1000;
        const done = frame + 1;
        opts.onProgress?.({
          ...ctx,
          progress: done / totalFrames,
          elapsed,
          remaining: (elapsed / done) * (totalFrames - done),
          renderFps: done / Math.max(elapsed, 1e-6),
        });
        // Keep the page responsive and let the progress UI paint.
        await yieldToEventLoop();
        lastYield = performance.now();
      }
    }
    return await recorder.stop();
  } catch (err) {
    await recorder?.cancel().catch(() => {});
    throw err;
  } finally {
    setCanvasSize(canvas, prevW, prevH);
  }
}
