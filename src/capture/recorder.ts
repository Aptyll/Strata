/**
 * MP4 recording from a canvas, encoded in the browser with WebCodecs and
 * muxed with Mediabunny. No server and no ffmpeg involved.
 */
import {
  BufferTarget,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  type StreamTargetChunk,
  type VideoCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { type AnyCanvas, Resampler, downloadBlob, timestampName } from './util';

export type CaptureCodec = 'avc' | 'hevc' | 'vp9' | 'av1';

export interface RecordingOptions {
  /** Frames per second of the output file. Default 60. */
  fps?: number;
  /**
   * Output size in pixels. Default: the canvas size. If the canvas is larger
   * (supersampling), every frame is box filtered down to this size.
   * Odd values are rounded down to even ones, which H.264 requires.
   */
  width?: number;
  height?: number;
  /**
   * Codec, or a list in order of preference; the first one this browser can
   * encode at the requested size is used. Default: H.264 first (what YouTube
   * recommends), then HEVC, AV1, VP9 as fallbacks for sizes H.264 can't do.
   */
  codec?: CaptureCodec | CaptureCodec[];
  /**
   * Bitrate in bits per second. Default: `bitsPerPixel * width * height * fps`.
   */
  bitrate?: number;
  /**
   * Used when `bitrate` is not given. Default 0.15, about 75 Mbit/s at 4K60.
   * Dense particle fields are close to noise and need far more bits than
   * ordinary footage, and YouTube re-encodes whatever is uploaded, so it pays
   * to be generous here.
   */
  bitsPerPixel?: number;
  /** Seconds between keyframes. Default 0.5 (YouTube asks for half the frame rate). */
  keyFrameInterval?: number;
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /**
   * 'fixed' (default): frame N is stamped N / fps regardless of how long it
   * took to render. This is what makes offline renders perfectly smooth.
   * 'realtime': frames are stamped with wall clock time, for recording live
   * interaction. Frames that arrive while the encoder is busy are dropped.
   */
  timing?: 'fixed' | 'realtime';
  /**
   * Where the file goes. 'memory' (default) keeps it in RAM and returns a
   * Blob. Pass a FileSystemFileHandle (see {@link pickOutputFile}) to stream
   * straight to disk, which is what you want for long 4K renders.
   */
  output?: 'memory' | FileSystemFileHandle;
  /** Download the result when stopped (memory output only). Default false. */
  download?: boolean;
  /** File name for the download. Default `strata-YYYYMMDD-HHMMSS.mp4`. */
  filename?: string;
  /** Colour painted under each frame when resampling. Default black. */
  background?: string;
}

/** Anything a 2D canvas can draw that knows its own pixel size. */
export type FrameImage = HTMLCanvasElement | OffscreenCanvas | ImageBitmap | VideoFrame;

function imageSize(image: FrameImage): [number, number] {
  if (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame) {
    return [image.displayWidth, image.displayHeight];
  }
  return [(image as ImageBitmap).width, (image as ImageBitmap).height];
}

export interface RecordingResult {
  /** The MP4 file, or null when it was streamed to a file handle. */
  blob: Blob | null;
  mimeType: string;
  codec: CaptureCodec;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  frames: number;
  droppedFrames: number;
  /** Duration of the video in seconds. */
  duration: number;
  /** Wall clock seconds spent between start and stop. */
  elapsed: number;
}

export interface Recorder {
  readonly codec: CaptureCodec;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrate: number;
  /** Frames added so far. */
  readonly frames: number;
  readonly droppedFrames: number;
  /** Video time of the next frame, in seconds. */
  readonly time: number;
  readonly active: boolean;
  /**
   * Captures the canvas as the next video frame. Call it right after
   * rendering, in the same task. The canvas is copied synchronously; the
   * returned promise resolves when the encoder is ready for another frame, so
   * offline loops should await it.
   *
   * Pass an image to encode that instead of the canvas, for example a
   * VideoFrame from {@link TextureReader}. A VideoFrame passed in is closed
   * by the recorder.
   */
  addFrame(image?: FrameImage): Promise<void>;
  /** Finishes the file. */
  stop(): Promise<RecordingResult>;
  /** Aborts and discards the output. */
  cancel(): Promise<void>;
}

const DEFAULT_CODECS: CaptureCodec[] = ['avc', 'hevc', 'av1', 'vp9'];

/** True if this browser can record at all. */
export function isRecordingSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

interface SaveFilePicker {
  showSaveFilePicker(options?: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }): Promise<FileSystemFileHandle>;
}

/**
 * Opens a save dialog and returns a file handle to pass as
 * `RecordingOptions.output`. Must be called from a click or key handler.
 * Chromium only.
 */
export function pickOutputFile(suggestedName = timestampName('strata', 'mp4')): Promise<FileSystemFileHandle> {
  const w = globalThis as unknown as Partial<SaveFilePicker>;
  if (!w.showSaveFilePicker) {
    throw new Error('capture: this browser has no showSaveFilePicker; use memory output instead.');
  }
  return w.showSaveFilePicker({
    suggestedName,
    types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
  });
}

/**
 * Starts an MP4 recording of a canvas.
 *
 * ```ts
 * const rec = await startRecording(canvas, { fps: 60 });
 * // after each rendered frame:
 * await rec.addFrame();
 * // when done:
 * const { blob } = await rec.stop();
 * ```
 */
export async function startRecording(canvas: AnyCanvas, opts: RecordingOptions = {}): Promise<Recorder> {
  if (!isRecordingSupported()) {
    throw new Error('capture: WebCodecs VideoEncoder is not available in this browser.');
  }
  const fps = opts.fps ?? 60;
  const width = Math.floor((opts.width ?? canvas.width) / 2) * 2;
  const height = Math.floor((opts.height ?? canvas.height) / 2) * 2;
  if (!(fps > 0) || width < 2 || height < 2) {
    throw new RangeError(`capture: invalid recording size or rate (${width}x${height} @ ${fps}).`);
  }
  const bitrate = Math.round(opts.bitrate ?? (opts.bitsPerPixel ?? 0.15) * width * height * fps);
  const hardwareAcceleration = opts.hardwareAcceleration ?? 'no-preference';
  const wanted = opts.codec ? (Array.isArray(opts.codec) ? opts.codec : [opts.codec]) : DEFAULT_CODECS;
  const timing = opts.timing ?? 'fixed';
  const latencyMode = timing === 'realtime' ? 'realtime' : 'quality';

  const codec = (await getFirstEncodableVideoCodec(wanted as VideoCodec[], {
    width,
    height,
    bitrate,
    frameRate: fps,
  })) as CaptureCodec | null;
  if (!codec) {
    throw new Error(
      `capture: this browser cannot encode ${wanted.join('/')} at ${width}x${height}. ` +
        `Try a smaller size or another codec.`,
    );
  }

  const toDisk = opts.output && opts.output !== 'memory' ? opts.output : null;
  let target: BufferTarget | StreamTarget;
  if (toDisk) {
    const writable = (await toDisk.createWritable()) as unknown as WritableStream<StreamTargetChunk>;
    target = new StreamTarget(writable, { chunked: true });
  } else {
    target = new BufferTarget();
  }
  const output = new Output({
    // In memory we can put the index at the front so the file starts playing
    // immediately. When streaming to disk the index goes at the end, which
    // YouTube and every player handle fine.
    format: new Mp4OutputFormat({ fastStart: toDisk ? false : 'in-memory' }),
    target,
  });

  // Frames that already have the output size are encoded directly. Anything
  // else (supersampled or resized canvases) goes through a 2D canvas that
  // box filters it down, created on first use.
  let resampler: Resampler | null = null;
  const source = new VideoSampleSource({
    codec,
    bitrate,
    keyFrameInterval: opts.keyFrameInterval ?? 0.5,
    hardwareAcceleration,
    latencyMode,
    bitrateMode: 'variable',
    alpha: 'discard',
  });
  output.addVideoTrack(source, timing === 'fixed' ? { frameRate: fps } : {});
  await output.start();

  const startedAt = performance.now();
  const frameDuration = 1 / fps;
  let frames = 0;
  let dropped = 0;
  let active = true;
  let busy = false;
  let lastTimestamp = -Infinity;
  let failure: unknown = null;

  const recorder: Recorder = {
    codec,
    width,
    height,
    fps,
    bitrate,
    get frames() {
      return frames;
    },
    get droppedFrames() {
      return dropped;
    },
    get time() {
      return timing === 'fixed' ? frames * frameDuration : (performance.now() - startedAt) / 1000;
    },
    get active() {
      return active;
    },

    addFrame(image?: FrameImage): Promise<void> {
      const closeInput = () => {
        if (image && typeof VideoFrame !== 'undefined' && image instanceof VideoFrame) image.close();
      };
      if (!active || failure) {
        closeInput();
        return Promise.reject(failure ?? new Error('capture: recording is not active.'));
      }
      let timestamp: number;
      if (timing === 'fixed') {
        timestamp = frames * frameDuration;
      } else {
        // Live recording must never stall the render loop: skip this frame if
        // the encoder has not caught up, or if it arrived too soon.
        timestamp = (performance.now() - startedAt) / 1000;
        if (busy || timestamp - lastTimestamp < frameDuration * 0.5) {
          if (busy) dropped++;
          closeInput();
          return Promise.resolve();
        }
      }
      // Everything up to here and the copy below is synchronous, so the
      // canvas is read in the same task that rendered it.
      let sample: VideoSample;
      try {
        const src = image ?? canvas;
        const [sw, sh] = imageSize(src);
        if (sw === width && sh === height) {
          sample = new VideoSample(src, { timestamp, duration: frameDuration });
        } else {
          resampler ??= new Resampler(width, height, opts.background ?? '#000');
          resampler.draw(src, sw, sh);
          sample = new VideoSample(resampler.canvas, { timestamp, duration: frameDuration });
        }
      } catch (err) {
        closeInput();
        return Promise.reject(err);
      }
      lastTimestamp = timestamp;
      frames++;
      busy = true;
      return source.add(sample).then(
        () => {
          busy = false;
          sample.close();
          closeInput();
        },
        (err) => {
          busy = false;
          sample.close();
          closeInput();
          failure = err;
          throw err;
        },
      );
    },

    async stop(): Promise<RecordingResult> {
      if (!active) throw new Error('capture: recording is not active.');
      active = false;
      if (failure) {
        await output.cancel().catch(() => {});
        throw failure;
      }
      await output.finalize();
      const mimeType = await output.getMimeType();
      let blob: Blob | null = null;
      if (target instanceof BufferTarget && target.buffer) {
        blob = new Blob([target.buffer], { type: 'video/mp4' });
        if (opts.download) downloadBlob(blob, opts.filename ?? timestampName('strata', 'mp4'));
      }
      return {
        blob,
        mimeType,
        codec,
        width,
        height,
        fps,
        bitrate,
        frames,
        droppedFrames: dropped,
        duration: timing === 'fixed' ? frames * frameDuration : lastTimestamp + frameDuration,
        elapsed: (performance.now() - startedAt) / 1000,
      };
    },

    async cancel(): Promise<void> {
      if (!active) return;
      active = false;
      await output.cancel();
    },
  };
  return recorder;
}
