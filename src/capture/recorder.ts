/**
 * MP4 recording from a canvas, encoded in the browser with WebCodecs and
 * muxed with Mediabunny. No server and no ffmpeg involved.
 */
import type { AudioBufferSource, BufferTarget, StreamTarget, StreamTargetChunk, VideoCodec, VideoSample } from 'mediabunny';
import { type AnyCanvas, FilterStage, Resampler, cssFilterOf, downloadBlob, timestampName } from './util';
import { I420Converter } from './yuv';

export type CaptureCodec = 'avc' | 'hevc' | 'vp9' | 'av1';

/** Audio codecs a recording can carry: AAC where the browser can encode it, else Opus. */
export type CaptureAudioCodec = 'aac' | 'opus';

/**
 * A soundtrack handed over in step with the video, for fixed timing
 * recordings. src/audio's createRecordingAudio makes one; any object of this
 * shape works.
 */
export interface RecordingAudio {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  /**
   * Called after each video frame with the video time covered so far. Returns
   * the audio that follows the last buffer it returned, or null when no new
   * chunk is ready yet. Hand audio over a few seconds at a time as the video
   * advances: the muxer holds encoded video in memory until audio for the
   * same time arrives.
   */
  pull(videoTime: number): Promise<AudioBuffer | null>;
  /** Called once when the recording stops. Returns the rest, so the audio ends exactly at `duration`. */
  finish(duration: number): Promise<AudioBuffer | null>;
  /** Called if the recording is cancelled or fails. It may come more than once, and after finish. */
  cancel?(): void;
}

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
  /**
   * CSS filter baked into every frame. Default: the canvas element's own
   * computed filter (the app's color themes), read each frame so a theme
   * change shows up in the video. Null records the raw canvas pixels.
   */
  filter?: string | null;
  /**
   * 'limited': the recorder converts frames to BT.709 limited range YUV
   * itself, which every player, editor and converter reads the same way. It
   * reads each frame back to the CPU in the task that rendered it, which
   * waits for the GPU, and converts in script: tens of milliseconds a frame
   * at 4K. 'full': hand the encoder the canvas and let the browser convert,
   * which gives full-range YUV that players and YouTube read correctly but
   * some editors misread (faint pixels turn black).
   * Default: 'limited' for fixed timing, 'full' for realtime, because a live
   * recording must not slow down the view it records. See {@link recordingRange}.
   */
  range?: 'limited' | 'full';
  /**
   * A soundtrack to mux in, as an AAC track (Opus where the browser cannot
   * encode AAC). Needs fixed timing. The recorder pulls audio after every
   * frame and asks for the rest when it stops. Default: no audio track.
   */
  audio?: RecordingAudio | null;
  /** Audio bitrate in bits per second. Default 192000 (Windows' AAC encoder takes 96, 128, 160 or 192 kbit/s). */
  audioBitrate?: number;
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
  /** The audio track's codec, or null for a silent file. */
  audioCodec: CaptureAudioCodec | null;
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
  /** The audio track's codec, or null when the recording has no soundtrack. */
  readonly audioCodec: CaptureAudioCodec | null;
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

/**
 * The colour range a recording uses: the one asked for, else 'limited' for
 * fixed timing and 'full' for realtime. The limited conversion reads every
 * frame back in the task that rendered it, so on a live recording it would
 * hold up the frame loop, which realtime timing promises never to do.
 */
export function recordingRange(opts: Pick<RecordingOptions, 'range' | 'timing'>): 'limited' | 'full' {
  return opts.range ?? (opts.timing === 'realtime' ? 'full' : 'limited');
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
  try {
    return await openRecording(canvas, opts);
  } catch (err) {
    opts.audio?.cancel?.(); // the soundtrack will never be asked for, so let its owner know
    throw err;
  }
}

async function openRecording(canvas: AnyCanvas, opts: RecordingOptions): Promise<Recorder> {
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
  const audio = opts.audio ?? null;
  if (audio && timing !== 'fixed') {
    throw new Error('capture: a soundtrack needs fixed timing; realtime recordings have no audio track.');
  }

  // Mediabunny is about 220 kB of script that only a recording needs, so it is
  // fetched here, when the first recording starts, and not with the page.
  const {
    AudioBufferSource, BufferTarget, Mp4OutputFormat, Output, StreamTarget, VideoSample, VideoSampleSource,
    getFirstEncodableAudioCodec, getFirstEncodableVideoCodec,
  } = await import('mediabunny').catch((cause) => {
    // Offline, or the tab is older than the last deploy and the file moved.
    throw new Error('capture: could not load the video encoder. Check the connection, or reload the page.', { cause });
  });

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
  const audioBitrate = opts.audioBitrate ?? 192_000;
  const audioCodec = audio
    ? ((await getFirstEncodableAudioCodec(['aac', 'opus'], {
        numberOfChannels: audio.numberOfChannels,
        sampleRate: audio.sampleRate,
        bitrate: audioBitrate,
      })) as CaptureAudioCodec | null)
    : null;
  if (audio && !audioCodec) {
    throw new Error(`capture: this browser cannot encode the soundtrack as AAC or Opus at ${audio.sampleRate} Hz.`);
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
  // box filters it down, created on first use. A CSS filter on the canvas is
  // baked in last, after the downsample.
  let resampler: Resampler | null = null;
  let filterStage: FilterStage | null = null;
  const yuv = recordingRange(opts) === 'full' ? null : new I420Converter();
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
  // The muxer interleaves by time, so it holds encoded video until audio for
  // the same time arrives. The soundtrack is therefore pulled after every
  // frame, a few seconds at a time, rather than added at the end.
  let audioSource: AudioBufferSource | null = null;
  if (audio && audioCodec) {
    audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: audioBitrate });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const startedAt = performance.now();
  const frameDuration = 1 / fps;
  let frames = 0;
  let dropped = 0;
  let active = true;
  let busy = false;
  let lastTimestamp = -Infinity;
  let failure: unknown = null;

  /**
   * Encodes the soundtrack's next piece, if it has one, once the piece before
   * it is done, so pieces never overlap. A failure here fails the recording,
   * like a video one.
   */
  let audioQueue: Promise<void> = Promise.resolve();
  const feedAudio = (next: () => Promise<AudioBuffer | null>): Promise<void> => {
    const run = audioQueue.then(async () => {
      if (!audioSource) return;
      if (failure) throw failure;
      try {
        const buffer = await next();
        if (buffer) await audioSource.add(buffer);
      } catch (err) {
        failure ??= err;
        throw err;
      }
    });
    audioQueue = run.catch(() => {});
    return run;
  };

  const recorder: Recorder = {
    codec,
    width,
    height,
    fps,
    bitrate,
    audioCodec,
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
        let frame: FrameImage = src;
        if (sw !== width || sh !== height) {
          resampler ??= new Resampler(width, height, opts.background ?? '#000');
          resampler.draw(src, sw, sh);
          frame = resampler.canvas;
        }
        const filter = opts.filter === undefined ? cssFilterOf(canvas) : opts.filter;
        if (filter) frame = (filterStage ??= new FilterStage()).draw(frame, width, height, filter);
        sample = yuv
          ? new VideoSample(yuv.convert(frame, width, height, timestamp, frameDuration), {
              timestamp,
              duration: frameDuration,
            })
          : new VideoSample(frame, { timestamp, duration: frameDuration });
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
          // Whatever audio the video now covers goes in too.
          if (audio) return feedAudio(() => audio.pull(timestamp + frameDuration));
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
      const duration = timing === 'fixed' ? frames * frameDuration : lastTimestamp + frameDuration;
      // The rest of the soundtrack, ending exactly with the last frame. A failure lands in `failure`.
      if (audio && !failure) await feedAudio(() => audio.finish(duration)).catch(() => {});
      if (failure) {
        audio?.cancel?.();
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
        audioCodec,
        duration,
        elapsed: (performance.now() - startedAt) / 1000,
      };
    },

    async cancel(): Promise<void> {
      if (!active) return;
      active = false;
      audio?.cancel?.();
      await output.cancel();
    },
  };
  return recorder;
}
