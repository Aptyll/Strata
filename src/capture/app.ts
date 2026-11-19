/**
 * Capture inside the Strata app: P saves a screenshot, V starts and stops a
 * live recording, and the settings menu gets a "capture" section for
 * high-resolution stills and offline video.
 *
 * The app hands over a small host object instead of its internals, so this
 * file does not depend on how the frame loop is built.
 */
import type { Pass } from '../core/contracts';
import { TOKENS } from '../core/contracts';
import type { Hud } from '../ux/hud/index.js';
import { createCapturePass } from './capturePass';
import { renderOffline } from './offline';
import { isRecordingSupported, pickOutputFile, type RecordingAudio, type RecordingResult } from './recorder';
import { captureStillPNG } from './still';
import { downloadBlob, timestampName } from './util';

/** The parts of the HUD this module uses. */
export type CaptureHud = Pick<Hud, 'registerParam' | 'registerShortcut'>;

export interface CaptureHost {
  canvas: HTMLCanvasElement;
  hud: CaptureHud;
  /** Largest texture side the GPU supports. */
  maxTextureSize: number;
  addPass(pass: Pass): void;
  /** Simulate and draw one frame `dt` seconds after the previous one, synchronously. */
  frame(dt: number): void;
  /** Resolves when the GPU has finished the submitted work. */
  flush?: () => Promise<unknown>;
  /** While on, the app's realtime loop must not draw: this module calls `frame` itself. */
  setOffline(on: boolean): void;
  /**
   * Fixes the drawing buffer size, or null to follow the window again. While the size is
   * fixed, a host whose particles light a fixed number of pixels should scale their light
   * by (height / window height)^2, or captures taller than the window come out darker.
   */
  setResolution(size: { width: number; height: number } | null): void;
  /**
   * Optional soundtrack for offline video, muxed into the MP4. Called once
   * right before each render starts (the realtime loop already stopped), with
   * the video's frame rate; every frame rendered until the recording finishes
   * or is cancelled belongs to it. Return null for a silent video. Live
   * recordings (V) stay silent.
   */
  audio?: (fps: number) => RecordingAudio | null | undefined;
  /**
   * Keys for the two live actions, as HUD shortcut names. The app passes its
   * rows from src/app/keys.ts. Defaults: P screenshot, V record video.
   */
  keys?: { screenshot?: CaptureKey; record?: CaptureKey };
}

/** A HUD shortcut key and the label shown for it in the keys sheet. */
export interface CaptureKey {
  key: string;
  label: string;
}

const SIZES: Record<string, [number, number]> = {
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4k': [3840, 2160],
  '8k': [7680, 4320],
};

const clock = (seconds: number) => {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function mountCapture(host: CaptureHost): void {
  const { canvas, hud } = host;

  /** One quiet line at the bottom of the screen while something is being captured. */
  const line = document.createElement('div');
  Object.assign(line.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: `${TOKENS.unit * 4}px`,
    textAlign: 'center',
    pointerEvents: 'none',
    font: TOKENS.font,
    letterSpacing: TOKENS.letterSpacing,
    color: TOKENS.color.foreground,
    opacity: '0',
    transition: `opacity ${TOKENS.durationMs}ms ${TOKENS.easing}`,
  });
  document.body.appendChild(line);
  let hideTimer = 0;
  const status = (text: string, holdMs = 0) => {
    clearTimeout(hideTimer);
    line.textContent = text;
    line.style.opacity = String(TOKENS.opacityDim);
    if (holdMs) hideTimer = window.setTimeout(() => (line.style.opacity = '0'), holdMs);
  };

  // ---- live: screenshot and realtime recording ----------------------------
  const pass = createCapturePass(canvas, {
    screenshotKey: null, // keys go through the HUD so they show up in its key list
    recordKey: null,
    onStatus: (text) => status(text, text.startsWith('Recording') ? 0 : 2500),
  });
  host.addPass(pass);
  const live = pass.controller;

  let busy = false;
  let abort: AbortController | null = null;

  const screenshotKey = host.keys?.screenshot ?? { key: 'p', label: 'screenshot' };
  const recordKey = host.keys?.record ?? { key: 'v', label: 'record video' };
  hud.registerShortcut({
    key: screenshotKey.key,
    label: screenshotKey.label,
    run: (e) => !busy && !e.repeat && live.requestScreenshot(),
  });
  hud.registerShortcut({
    key: recordKey.key,
    label: recordKey.label,
    run: (e) => {
      if (busy || e.repeat) return;
      void live.toggleRecording().catch(() => {});
    },
  });

  // ---- settings -----------------------------------------------------------
  const settings = { size: '4k', fps: 60, seconds: 30, supersample: false, toDisk: false };
  const group = 'capture';
  hud.registerParam({
    id: 'capture.size', label: 'resolution', group, type: 'select', value: settings.size,
    options: Object.keys(SIZES).filter((k) => SIZES[k][0] <= host.maxTextureSize),
    onChange: (v: string) => (settings.size = v),
  });
  hud.registerParam({
    id: 'capture.fps', label: 'frame rate', group, type: 'select', value: String(settings.fps),
    options: ['24', '30', '60'],
    onChange: (v: string) => (settings.fps = Number(v)),
  });
  hud.registerParam({
    id: 'capture.seconds', label: 'length', group, type: 'range', min: 5, max: 600, step: 5, value: settings.seconds,
    format: (v) => clock(v),
    onChange: (v: number) => (settings.seconds = v),
  });
  hud.registerParam({
    id: 'capture.supersample', label: 'supersample 2x', group, type: 'toggle', value: settings.supersample,
    onChange: (v: boolean) => (settings.supersample = v),
  });
  hud.registerParam({
    id: 'capture.disk', label: 'save straight to disk', group, type: 'toggle', value: settings.toDisk,
    onChange: (v: boolean) => (settings.toDisk = v),
  });

  /** Render size for the chosen settings, with supersampling dropped if the GPU cannot hold it. */
  const plan = () => {
    const [width, height] = SIZES[settings.size] ?? SIZES['1080p'];
    const supersample = settings.supersample && width * 2 <= host.maxTextureSize ? 2 : 1;
    return { width, height, supersample };
  };

  /** Runs a capture that needs the frame loop to itself at a fixed resolution. */
  async function exclusive(size: { width: number; height: number }, run: () => Promise<void>): Promise<void> {
    if (busy) return;
    if (live.recording) await live.stopRecording();
    busy = true;
    const fit = canvas.style.objectFit;
    canvas.style.objectFit = 'contain'; // show the frame undistorted while the buffer has another shape
    host.setOffline(true);
    host.setResolution(size);
    try {
      await run();
    } catch (err) {
      if ((err as Error).name === 'AbortError') status('Cancelled', 2500);
      else {
        console.error(err);
        status(`Capture failed: ${(err as Error).message ?? err}`, 6000);
      }
    } finally {
      host.setResolution(null);
      host.setOffline(false);
      canvas.style.objectFit = fit;
      busy = false;
      abort = null;
    }
  }

  hud.registerParam({
    id: 'capture.still', label: 'save still', group, type: 'action',
    run: () => {
      const { width, height, supersample } = plan();
      void exclusive({ width: width * supersample, height: height * supersample }, async () => {
        status(`Rendering ${width}x${height} still`);
        const blob = await captureStillPNG({
          canvas, width, height, supersample,
          maxRenderSize: host.maxTextureSize,
          render: () => host.frame(0),
        });
        const name = timestampName('strata', 'png');
        downloadBlob(blob, name);
        status(`Saved ${name}`, 2500);
      });
    },
  });

  hud.registerParam({
    id: 'capture.video', label: 'render video', group, type: 'action',
    run: () => {
      // Pressing it again while a render is running cancels that render.
      if (abort) return abort.abort();
      if (busy) return;
      if (!isRecordingSupported()) return status('This browser cannot encode video', 4000);
      const { width, height, supersample } = plan();
      const { fps, seconds } = settings;
      const controller = new AbortController();
      void (async () => {
        // The save dialog has to open while the click is still fresh.
        let output: 'memory' | FileSystemFileHandle = 'memory';
        if (settings.toDisk) {
          try {
            output = await pickOutputFile();
          } catch {
            return; // dialog dismissed, or not available in this browser
          }
        }
        await exclusive({ width: width * supersample, height: height * supersample }, async () => {
          abort = controller;
          const audio = host.audio?.(fps) ?? null;
          status(`Rendering ${width}x${height} at ${fps} fps${audio ? ' with sound' : ''}`);
          let result: RecordingResult;
          try {
            result = await renderOffline({
              canvas, width, height, fps, supersample,
              duration: seconds,
              step: () => {},
              // The app simulates and draws in one call, so each video frame is one app frame.
              render: () => host.frame(1 / fps),
              flush: host.flush,
              recording: { output, audio },
              signal: controller.signal,
              onProgress: (p) =>
                status(
                  `Rendering ${Math.round(p.progress * 100)}%  ${clock(p.time)} of ${clock(seconds)}  ` +
                    `${clock(p.remaining)} left  (render video again to cancel)`,
                ),
            });
          } catch (err) {
            audio?.cancel?.(); // in case the render failed before the recorder took the soundtrack
            throw err;
          }
          if (result.blob) downloadBlob(result.blob, timestampName('strata', 'mp4'));
          const sound = result.audioCodec ? ' with sound' : '';
          status(`Saved ${clock(result.duration)} of ${result.codec} video${sound} in ${clock(result.elapsed)}`, 6000);
        });
      })();
    },
  });
}
