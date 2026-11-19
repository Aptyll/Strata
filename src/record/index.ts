/**
 * Record: launch a record-scale render from the app, as one Esc-menu job or
 * from a URL. A thin wrapper around src/offline: renderJob does the batched,
 * checkpointed, resumable GPU work, gradeJob does the tone mapping, and
 * src/capture encodes clips. This file only builds the job, reports progress
 * through the HUD, saves the result, and prints an honest tally per frame.
 *
 * URL (all optional; ?record alone renders one 1 trillion particle 4K still):
 *   ?record                    start the record job as soon as the app is up (count from the menu, default 1T)
 *   ?record=1e12               particles per frame: also 250M, 10B, 1T
 *   &size=4k                   1080p, 1440p, 4k, 8k (default: the menu's capture resolution)
 *   &frames=1                  more than 1 renders a clip and encodes an MP4; or &seconds=10
 *   &shot=heroA                a hand-placed composition from src/offline (heroA, heroB, heroC) instead of the
 *                              cluster; it brings its own splat and weighting unless given below
 *   &fps=60  &sheets=1024  &seed=1
 *   &weighting=count           count (default): every particle adds exactly one unit; flux: far sheets dimmer
 *   &fresh=1                   discard a saved partial render of the same job and start over
 *
 * Frames are kept in the browser's private storage, one folder per job, so a
 * reload or a crash continues where it stopped: open the same URL again.
 * While a frame renders, a preview of it sharpens over the app every 15 s,
 * captioned with the GPU's own running tally.
 */
import { downloadBlob, startRecording, timestampName } from "../capture";
import { TOKENS } from "../core/contracts";
import { buildManifest } from "../manifest/manifest.mjs";
import { COMPOSITIONS } from "../offline/core/compositions";
import { develop, frameStats, type FrameStats } from "../offline/core/develop";
import { DEFAULT_LOOK, exposureTrack, gradeFrame, toneTable, withCommas } from "../offline/core/grade";
import { totalParticles, type OfflineJob, type SplatMode, type Weighting } from "../offline/core/job";
import { StatelessRenderer } from "../offline/core/renderer";
import { gradeJob, jobFingerprint, loadStats, renderJob, type FileStore } from "../offline/core/session";
import { PRESETS, clusterJob } from "../offline/core/world";
import { browserZlib, directoryStore, memoryStore } from "../offline/web/platform";
import type { Hud, JobHandle } from "../ux/hud/index.js";

/** The parts of the HUD this module uses. */
export type RecordHud = Pick<Hud, "registerJob" | "registerParam" | "getParam">;

const SIZES: Record<string, [number, number]> = {
  "1080p": [1920, 1080],
  "1440p": [2560, 1440],
  "4k": [3840, 2160],
  "8k": [7680, 4320],
};

const COUNTS = ["1M", "100M", "1B", "10B", "100B", "1T"];
/** "cluster" is the trillion preset's field of sheets; the rest are src/offline compositions. */
const SHOTS = ["cluster", ...Object.keys(COMPOSITIONS)];

/** Accepts 1e12, 1_000_000, 250M, 10B, 1T. */
export function parseCount(v: string): number {
  const s = v.replace(/[_,\s]/g, "").toUpperCase();
  const mult = ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as Record<string, number>)[s.slice(-1)];
  const n = mult ? Number(s.slice(0, -1)) * mult : Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`not a positive number: ${v}`);
  return Math.round(n);
}

export function shortCount(n: number): string {
  for (const [d, s] of [[1e12, "T"], [1e9, "B"], [1e6, "M"]] as const) if (n >= d) return `${+(n / d).toFixed(2)}${s}`;
  return withCommas(n);
}

export interface RecordSettings {
  particles: number;
  width: number;
  height: number;
  frames: number;
  fps: number;
  planes?: number;
  seed?: number;
  weighting?: Weighting;
  splat?: SplatMode;
  /** "cluster" (default) or a key of src/offline's COMPOSITIONS. */
  shot?: string;
}

/** The offline job for some settings. Same settings, same job, so a rerun resumes it. */
export function recordJob(s: RecordSettings): OfflineJob {
  const preset = PRESETS.trillion;
  const composition = s.shot ? COMPOSITIONS[s.shot] : undefined;
  if (composition) {
    return composition.build({
      ...composition.defaults,
      name: `record-${s.shot}-${shortCount(s.particles)}-${s.width}x${s.height}-${s.frames}f`,
      width: s.width,
      height: s.height,
      fps: s.fps,
      frames: s.frames,
      particles: s.particles,
      seed: s.seed ?? composition.defaults.seed ?? 1,
      // A composition picks its own splat and weighting (bilinear against moire, flux for depth)
      // unless the URL says otherwise. Evaluated and landed are GPU-counted either way.
      weighting: s.weighting,
      splat: s.splat,
    });
  }
  return clusterJob({
    ...preset,
    name: `record-${shortCount(s.particles)}-${s.width}x${s.height}-${s.frames}f`,
    width: s.width,
    height: s.height,
    fps: s.fps,
    frames: s.frames,
    particles: s.particles,
    // Fewer sheets for small counts, so each one still holds a dense picture.
    planes: s.planes ?? Math.max(16, Math.min(preset.planes, Math.round(s.particles / 1e9))),
    seed: s.seed ?? preset.seed ?? 1,
    weighting: s.weighting ?? "count",
    splat: s.splat ?? (s.particles > 2e10 ? "point" : "bilinear"),
  });
}

/** One frame's honest count, as printed and saved in the manifest. */
export interface FrameTally {
  frame: number;
  /** Particles in the world. */
  particles: number;
  /** Particles the GPU evaluated for this frame. */
  evaluated: number;
  /** Particles that landed inside the picture, counted on the GPU. */
  landed: string;
  /** evaluated - landed: behind the camera or outside the frame. */
  outside: string;
  /** Exact sum of the accumulation grid in weight units. */
  unitSum: string;
  weighting: Weighting;
  /** GPU seconds for this frame, and particles per second. */
  seconds: number;
  rate: number;
  /** True when every particle in the world was evaluated. */
  allEvaluated: boolean;
}

export function frameTally(stats: FrameStats, job: OfflineJob): FrameTally {
  const particles = totalParticles(job);
  // Stats store the GPU's count as a decimal string. Worlds stay below 2^53.
  const evaluated = Number(stats.evaluated);
  return {
    frame: stats.frame,
    particles,
    evaluated,
    landed: stats.landed,
    outside: (BigInt(stats.evaluated) - BigInt(stats.landed)).toString(),
    unitSum: stats.unitSum,
    weighting: job.weighting,
    seconds: stats.seconds,
    rate: evaluated / Math.max(stats.seconds, 1e-9),
    allEvaluated: evaluated === particles,
  };
}

export function tallyLine(t: FrameTally): string {
  return (
    `frame ${t.frame + 1}: ${withCommas(t.evaluated)} of ${withCommas(t.particles)} particles evaluated` +
    `${t.allEvaluated ? " (all)" : " (NOT all)"}, ${withCommas(t.landed)} in frame, ` +
    `${t.seconds.toFixed(1)} s at ${fmtRate(t.rate)}`
  );
}

const fmtRate = (r: number) => (r >= 1e9 ? `${(r / 1e9).toFixed(2)} billion/s` : `${(r / 1e6).toFixed(1)} million/s`);
function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return "?";
  if (s < 90) return `${s.toFixed(0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

/**
 * A store that never fails a render: writes go to `primary`, and if one
 * throws (quota full, private window, no OPFS write support) that file and
 * every later one are kept in memory instead. The render then finishes but
 * no longer survives a reload, and `degraded` says so.
 */
export function resilientStore(primary: FileStore, onDegrade: (err: unknown) => void): FileStore & { readonly degraded: boolean } {
  const fallback = memoryStore();
  let degraded = false;
  const held = new Set<string>();
  return {
    get degraded() {
      return degraded;
    },
    async read(name) {
      if (held.has(name)) return fallback.read(name);
      try {
        return await primary.read(name);
      } catch {
        return null;
      }
    },
    async write(name, data) {
      if (!degraded) {
        try {
          await primary.write(name, data);
          return;
        } catch (err) {
          degraded = true;
          onDegrade(err);
        }
      }
      held.add(name);
      await fallback.write(name, data);
    },
    async remove(name) {
      held.delete(name);
      await fallback.remove(name);
      await primary.remove(name).catch(() => {});
    },
  };
}

/** Frames live in the browser's private file system, one folder per job, so a rerun resumes. */
async function browserStore(job: OfflineJob, fresh: boolean): Promise<{ store: FileStore; persistent: boolean }> {
  const warn = (err: unknown) => console.warn("record: browser storage stopped accepting files; the rest of this render stays in memory and will not survive a reload", err);
  try {
    const root = await navigator.storage.getDirectory();
    const name = `strata-record-${jobFingerprint(job).toString(16)}`;
    if (fresh) await root.removeEntry(name, { recursive: true }).catch(() => {});
    void navigator.storage.persist?.().catch(() => {});
    return { store: resilientStore(directoryStore(await root.getDirectoryHandle(name, { create: true })), warn), persistent: true };
  } catch (err) {
    console.warn("record: browser storage unavailable, keeping frames in memory", err);
    return { store: memoryStore(), persistent: false };
  }
}

/**
 * Grade a frame that is still rendering, for a progressive preview. The white
 * point follows a percentile of the partial grid, so early previews look like
 * the final picture, only noisier, and sharpen as batches land.
 */
export function gradePartial(acc: { lo: Uint32Array; hi: Uint32Array; landed: bigint }, job: OfflineJob, frame: number): Uint8Array {
  const developed = develop(acc.lo, acc.hi, job.width, job.height, job.ssaa);
  const stats = frameStats(frame, acc, developed, { evaluated: 0n, seconds: 0, batches: 0 });
  const white = exposureTrack([stats], { ...DEFAULT_LOOK, smoothFrames: 0 })[0];
  return gradeFrame(developed.codes, toneTable(white, DEFAULT_LOOK), frame);
}

function grayToRgba(gray: Uint8Array, rgba: Uint8ClampedArray): void {
  for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
    rgba[o] = rgba[o + 1] = rgba[o + 2] = gray[i];
    rgba[o + 3] = 255;
  }
}

/**
 * The record picture over the app: the frame in progress, then the finished
 * one, with a caption. Click to close. The world view is paused behind it and
 * the HUD (z-index 10) stays on top.
 */
let view: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; image: ImageData; caption: HTMLDivElement } | null = null;

function closeView(): void {
  view?.canvas.remove();
  view?.caption.remove();
  view = null;
}

function showFrame(gray: Uint8Array, width: number, height: number, caption: string): void {
  if (!view || !view.canvas.isConnected || view.canvas.width !== width || view.canvas.height !== height) {
    closeView();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.title = "click to close";
    Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", objectFit: "contain", background: "#000", cursor: "pointer" });
    canvas.addEventListener("click", closeView);
    const text = document.createElement("div");
    Object.assign(text.style, {
      position: "fixed",
      left: `${TOKENS.unit * 5}px`,
      top: `${TOKENS.unit * 5}px`,
      pointerEvents: "none",
      whiteSpace: "pre",
      font: TOKENS.font,
      letterSpacing: TOKENS.letterSpacing,
      color: TOKENS.color.foreground,
      opacity: String(TOKENS.opacityDim),
    });
    document.body.append(canvas, text);
    view = { canvas, ctx: canvas.getContext("2d")!, image: new ImageData(width, height), caption: text };
  }
  grayToRgba(gray, view.image.data);
  view.ctx.putImageData(view.image, 0, 0);
  view.caption.textContent = caption;
}

export interface RecordOptions {
  hud: RecordHud;
  /** URL options; see the top of this file. Default: the page's query string. */
  query?: URLSearchParams;
}

/**
 * Adds "render record" to the capture section of the Esc menu, with a
 * particle-count setting. Returns the job handle; `start()` launches it.
 * The app should stop its own rendering while the job runs (hud `job` event).
 */
export function mountRecord({ hud, query = new URLSearchParams(location.search) }: RecordOptions): JobHandle {
  const group = "capture";
  // The count rides on ?record itself, so it can never reach the app's own ?particles (stored particles).
  const urlCount = query.get("record") || null;
  hud.registerParam({
    id: "record.particles", label: "record particles", group, type: "select",
    value: urlCount && COUNTS.includes(urlCount.toUpperCase()) ? urlCount.toUpperCase() : "1T",
    options: COUNTS,
  });
  hud.registerParam({
    id: "record.clip", label: "record a clip (else a still)", group, type: "toggle", value: false,
  });
  hud.registerParam({
    id: "record.shot", label: "record shot", group, type: "select",
    value: SHOTS.includes(query.get("shot") ?? "") ? query.get("shot")! : "cluster",
    options: SHOTS,
  });

  /** URL wins over the menu, so a shared link renders exactly what it says. */
  const settings = (): RecordSettings => {
    const q = query;
    const [sw, sh] = SIZES[String(q.get("size") ?? hud.getParam("capture.size") ?? "4k").toLowerCase()] ?? SIZES["4k"];
    const fps = q.has("fps") ? parseCount(q.get("fps")!) : Number(hud.getParam("capture.fps") ?? 60);
    const clip = q.has("frames") || q.has("seconds") || hud.getParam("record.clip") === true;
    const frames = q.has("frames")
      ? parseCount(q.get("frames")!)
      : clip
        ? Math.max(1, Math.round((q.has("seconds") ? Number(q.get("seconds")) : Number(hud.getParam("capture.seconds") ?? 10)) * fps))
        : 1;
    return {
      particles: parseCount(urlCount ?? String(hud.getParam("record.particles") ?? "1T")),
      width: q.has("width") ? parseCount(q.get("width")!) : sw,
      height: q.has("height") ? parseCount(q.get("height")!) : sh,
      frames,
      fps,
      planes: q.has("sheets") ? parseCount(q.get("sheets")!) : undefined,
      seed: q.has("seed") ? parseCount(q.get("seed")!) : undefined,
      weighting: (q.get("weighting") as Weighting | null) ?? undefined,
      splat: (q.get("splat") as SplatMode | null) ?? undefined,
      shot: q.get("shot") ?? String(hud.getParam("record.shot") ?? "cluster"),
    };
  };

  return hud.registerJob({
    id: "record",
    label: "render record",
    group,
    async run({ signal, progress }) {
      const job = recordJob(settings());
      const total = totalParticles(job);
      const what = `${shortCount(total)} particles, ${job.width}x${job.height}, ${job.frames === 1 ? "still" : `${job.frames} frames`}`;
      const { store, persistent } = await browserStore(job, query.get("fresh") === "1");

      if (!navigator.gpu) throw new Error("WebGPU is not available in this browser");
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("no GPU adapter found");
      const info = adapter.info;
      const device = await adapter.requestDevice({ requiredLimits: StatelessRenderer.requiredLimits(job, adapter) });
      const tallies: FrameTally[] = (await loadStats(store, job)).map((s) => frameTally(s, job));
      const started = new Date().toISOString();

      try {
        progress(0, `${what}: starting`);
        let lastPaint = 0;
        await renderJob(device, job, store, browserZlib, {
          // Browsers reset the GPU when one submission runs for about 2 s, so batches stay short.
          targetBatchMs: 120,
          checkpointSeconds: persistent ? 60 : 0,
          signal,
          // A preview of the frame in progress. Its caption is the GPU's own running tally.
          previewSeconds: 15,
          onPartial: (frame, acc, done, frameTotal) => {
            const frameText = job.frames > 1 ? `frame ${frame + 1} of ${job.frames}, ` : "";
            showFrame(
              gradePartial(acc, job, frame),
              job.width,
              job.height,
              `rendering ${what}: ${frameText}${((100 * done) / frameTotal).toFixed(0)}%\n` +
                `GPU tally so far: ${withCommas(acc.gpuEvaluated.toString())} of ${withCommas(total)} evaluated, ` +
                `${withCommas(acc.landed.toString())} in frame`,
            );
          },
          onProgress: (p) => {
            const t = performance.now();
            if (t - lastPaint < 250) return;
            lastPaint = t;
            const left = (p.total - p.done) / Math.max(p.rate, 1);
            const frameText = job.frames > 1 ? `frame ${p.frame + 1} of ${job.frames}, ` : "";
            progress(
              (p.frame + p.done / p.total) / job.frames,
              `${what}: ${frameText}${((100 * p.done) / p.total).toFixed(1)}%, ${fmtRate(p.rate)}, ${fmtDuration(left)} left in this frame`,
            );
          },
          onFrame: (stats) => {
            const t = frameTally(stats, job);
            const i = tallies.findIndex((x) => x.frame === t.frame);
            if (i >= 0) tallies[i] = t;
            else tallies.push(t);
            console.log(`[record] ${tallyLine(t)}`, t);
          },
        });
      } finally {
        device.destroy();
      }

      // Grade with src/offline's grade step and save.
      const base = timestampName(`strata-${shortCount(total)}`, "x").slice(0, -2);
      // The manifest (src/manifest) copies every number from the GPU-written frame stats.
      const manifest = await buildManifest({
        job,
        stats: await loadStats(store, job),
        commit: (import.meta.env.VITE_STRATA_COMMIT as string | undefined) ?? null,
        renderer: "src/offline StatelessRenderer",
        entry: location.href,
        gpu: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null,
        host: { userAgent: navigator.userAgent },
        jobFingerprint: jobFingerprint(job),
        look: { ...DEFAULT_LOOK },
        started,
        finished: new Date().toISOString(),
      });
      const rgba = new Uint8ClampedArray(job.width * job.height * 4);
      const canvas = new OffscreenCanvas(job.width, job.height);
      const ctx = canvas.getContext("2d")!;
      const image = new ImageData(rgba, job.width, job.height);
      let last: Uint8Array | null = null;
      let saved: string;

      if (job.frames === 1) {
        progress(1, `${what}: grading`);
        await gradeJob(store, browserZlib, async (_f, gray) => {
          last = gray;
        });
        if (!last) throw new Error("no finished frame to save");
        grayToRgba(last, rgba);
        ctx.putImageData(image, 0, 0);
        downloadBlob(await canvas.convertToBlob({ type: "image/png" }), `${base}.png`);
        saved = `${base}.png`;
      } else {
        const rec = await startRecording(canvas, { fps: job.fps, width: job.width, height: job.height, timing: "fixed" });
        try {
          await gradeJob(store, browserZlib, async (f, gray) => {
            signal.throwIfAborted();
            grayToRgba(gray, rgba);
            ctx.putImageData(image, 0, 0);
            await rec.addFrame(canvas);
            last = gray;
            progress((f + 1) / job.frames, `${what}: encoding frame ${f + 1} of ${job.frames}`);
          });
          const result = await rec.stop();
          if (result.blob) downloadBlob(result.blob, `${base}.mp4`);
          saved = `${base}.mp4`;
        } catch (err) {
          await rec.cancel().catch(() => {});
          throw err;
        }
      }
      downloadBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }), `${base}.json`);
      const t = manifest.frames[manifest.frames.length - 1];
      // The caption repeats the GPU's tally for the last frame, as the manifest records it.
      const lastTally = [...tallies].sort((a, b) => a.frame - b.frame).pop();
      if (last) {
        showFrame(last, job.width, job.height, lastTally ? `done: ${tallyLine(lastTally)}\nclick to close` : "done. click to close");
      }

      return t
        ? `saved ${saved} and ${base}.json. ${withCommas(t.evaluated)} of ${withCommas(manifest.particlesPerFrame)} evaluated, ${withCommas(t.landed)} in frame`
        : `saved ${saved}`;
    },
  });
}
