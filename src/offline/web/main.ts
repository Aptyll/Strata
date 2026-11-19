/**
 * Strata offline page: render a record-scale clip on this machine's GPU in
 * the browser, frame by frame into a folder (resumable), then export an MP4.
 *
 * Same core as the Node runner (../node/cli.mjs). The Node runner is the
 * better choice for renders that take many hours: no tab throttling, and it
 * recovers from a lost GPU on its own.
 */
import { pickOutputFile, startRecording } from "../../capture";
import type { FrameStats } from "../core/develop";
import { DEFAULT_LOOK, exposureTrack, gradeFrame, toneTable, withCommas } from "../core/grade";
import { totalParticles, type OfflineJob, type SplatMode } from "../core/job";
import { decodeGrayPng16 } from "../core/png";
import { StatelessRenderer } from "../core/renderer";
import { frameImageName, gradeJob, loadJob, renderJob, type FileStore } from "../core/session";
import { PRESETS, clusterJob, type ClusterOptions } from "../core/world";
import { COMPOSITIONS } from "../core/compositions";

const presetOptions = (name: string): ClusterOptions => COMPOSITIONS[name]?.defaults ?? PRESETS[name];
const buildJob = (name: string, o: ClusterOptions): OfflineJob => (COMPOSITIONS[name] ? COMPOSITIONS[name].build(o) : clusterJob(o));
import { browserZlib, canPickFolder, directoryStore, memoryStore, pickFolder } from "./platform";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const presetEl = $<HTMLSelectElement>("preset");
const fields = ["particles", "planes", "width", "height", "fps", "seconds", "seed"] as const;
const inputs = Object.fromEntries(fields.map((f) => [f, $<HTMLInputElement>(f)])) as Record<(typeof fields)[number], HTMLInputElement>;
const splatEl = $<HTMLSelectElement>("splat");
const weightingEl = $<HTMLSelectElement>("weighting");
const kernelEl = $<HTMLSelectElement>("kernel");

/** What each choice of "light" does, shown under the form. */
const WEIGHTING_NOTES: Record<string, string> = {
  flux: "flux: far sheets are dimmer, and every particle in view adds light",
  "flux-fast": "flux, quick: far sheets are dimmer, drawn by a random share of their particles (the first stills)",
  count: "count: every particle in view adds exactly one unit, so the grid sum is the count",
};
const summaryEl = $("summary");
const statusEl = $("status");
const folderBtn = $<HTMLButtonElement>("folder");
const renderBtn = $<HTMLButtonElement>("render");
const stopBtn = $<HTMLButtonElement>("stop");
const exportBtn = $<HTMLButtonElement>("export");
const view = $<HTMLCanvasElement>("view");

let store: FileStore = memoryStore();
let folderName = "";
let stopRequested = false;
let abort: AbortController | null = null;
let busy = false;

const setStatus = (text: string) => (statusEl.textContent = text);

/** Accepts 1e12, 1_000_000, 250M, 1B, 1T. */
function parseCount(v: string): number {
  const s = v.replace(/[_,\s]/g, "").toUpperCase();
  const mult = ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as Record<string, number>)[s.slice(-1)];
  const n = mult ? Number(s.slice(0, -1)) * mult : Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Not a positive number: ${v}`);
  return Math.round(n);
}

function shortCount(n: number): string {
  for (const [d, s] of [[1e12, "T"], [1e9, "B"], [1e6, "M"]] as const) if (n >= d && n % (d / 100) === 0) return `${n / d}${s}`;
  return String(n);
}

function fillFromPreset(name: string): void {
  const p = presetOptions(name);
  inputs.particles.value = shortCount(p.particles);
  inputs.planes.value = String(p.planes);
  inputs.width.value = String(p.width);
  inputs.height.value = String(p.height);
  inputs.fps.value = String(p.fps);
  inputs.seconds.value = String(+(p.frames / p.fps).toFixed(3));
  inputs.seed.value = String(p.seed ?? 1);
  splatEl.value = p.particles > 2e10 ? "point" : "bilinear";
  weightingEl.value = p.weighting === "count" ? "count" : p.fluxBits === 16 ? "flux-fast" : "flux";
  updateSummary();
}

function currentJob(): OfflineJob {
  const fps = Number(inputs.fps.value);
  const o: ClusterOptions = {
    ...presetOptions(presetEl.value),
    particles: parseCount(inputs.particles.value),
    planes: parseCount(inputs.planes.value),
    width: parseCount(inputs.width.value),
    height: parseCount(inputs.height.value),
    fps,
    frames: Math.max(1, Math.round(Number(inputs.seconds.value) * fps)),
    seed: parseCount(inputs.seed.value),
    splat: splatEl.value as SplatMode,
    weighting: weightingEl.value === "count" ? "count" : "flux",
    // "flux, quick" is the first renders' 16-bit weights. Otherwise the builder picks the finest.
    fluxBits: weightingEl.value === "flux-fast" ? 16 : undefined,
  };
  return buildJob(presetEl.value, o);
}

function updateSummary(): void {
  try {
    const job = currentJob();
    const n = totalParticles(job);
    summaryEl.textContent =
      `${withCommas(n)} particles\n${job.frames} frames, ${withCommas(n * job.frames)} particle evaluations\n` +
      (WEIGHTING_NOTES[weightingEl.value] ?? "");
  } catch (e) {
    summaryEl.textContent = (e as Error).message;
  }
}

for (const name of [...Object.keys(PRESETS), ...Object.keys(COMPOSITIONS)]) presetEl.add(new Option(name, name));
presetEl.value = "preview";
presetEl.addEventListener("change", () => fillFromPreset(presetEl.value));
for (const el of [...Object.values(inputs), splatEl, weightingEl]) el.addEventListener("input", updateSummary);
fillFromPreset(presetEl.value);

if (!canPickFolder()) {
  folderBtn.disabled = true;
  setStatus("This browser cannot write to a folder, so frames are kept in memory and a reload loses them. Chrome or Edge can resume renders.");
}

folderBtn.addEventListener("click", async () => {
  try {
    const dir = await pickFolder();
    store = directoryStore(dir);
    folderName = dir.name;
    // A folder that already holds a job continues that job.
    try {
      const job = await loadJob(store);
      setStatus(`Folder "${folderName}" holds the job "${job.name}". Render continues it, export encodes it.`);
    } catch {
      setStatus(`Frames will be saved in "${folderName}".`);
    }
  } catch (e) {
    if ((e as DOMException).name !== "AbortError") setStatus((e as Error).message);
  }
});

// ------------------------------------------------------------- preview ----

const preview = view.getContext("2d")!;

function showGray(gray: Uint8Array, width: number, height: number): void {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
    rgba[o] = rgba[o + 1] = rgba[o + 2] = gray[i];
    rgba[o + 3] = 255;
  }
  const image = new ImageData(rgba, width, height);
  if (view.width !== width || view.height !== height) {
    view.width = width;
    view.height = height;
  }
  preview.putImageData(image, 0, 0);
}

async function previewFrame(stats: FrameStats, width: number, height: number): Promise<void> {
  const file = await store.read(frameImageName(stats.frame));
  if (!file) return;
  const { samples } = await decodeGrayPng16(file, browserZlib);
  const white = exposureTrack([stats], { ...DEFAULT_LOOK, smoothFrames: 0 })[0];
  showGray(gradeFrame(samples, toneTable(white, DEFAULT_LOOK), stats.frame), width, height);
}

// -------------------------------------------------------------- render ----

const fmtRate = (r: number) => (r >= 1e9 ? `${(r / 1e9).toFixed(2)} billion/s` : `${(r / 1e6).toFixed(1)} million/s`);
function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return "?";
  if (s < 90) return `${s.toFixed(1)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

function setBusy(b: boolean): void {
  busy = b;
  renderBtn.disabled = exportBtn.disabled = folderBtn.disabled = b || (folderBtn.disabled && !canPickFolder());
  stopBtn.disabled = !b;
  for (const el of [presetEl, splatEl, weightingEl, ...Object.values(inputs)]) el.disabled = b;
}

async function openDevice(job: OfflineJob): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error("WebGPU is not available in this browser. Use Chrome or Edge, or the Node runner.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No GPU adapter found.");
  return adapter.requestDevice({ requiredLimits: StatelessRenderer.requiredLimits(job, adapter) });
}

renderBtn.addEventListener("click", async () => {
  if (busy) return;
  let job: OfflineJob;
  try {
    // A folder that already holds a job continues that job, whatever the form says.
    job = await loadJob(store).catch(() => currentJob());
  } catch (e) {
    setStatus((e as Error).message);
    return;
  }
  setBusy(true);
  stopRequested = false;
  abort = new AbortController();
  let device: GPUDevice | null = null;
  try {
    device = await openDevice(job);
    const total = totalParticles(job);
    let lastPaint = 0;
    let frameRates: number[] = [];
    const r = await renderJob(device, job, store, browserZlib, {
      // Browsers reset the GPU if one submission runs for about 2 s. Keep batches short.
      targetBatchMs: 120,
      kernel: kernelEl.value === "trillion" ? "trillion" : "offline",
      checkpointSeconds: canPickFolder() ? 300 : 0,
      shouldStop: () => stopRequested,
      signal: abort.signal,
      onProgress: (p) => {
        const t = performance.now();
        if (t - lastPaint < 250) return;
        lastPaint = t;
        const frameEta = (p.total - p.done) / Math.max(p.rate, 1);
        setStatus(`frame ${p.frame + 1} of ${job.frames}: ${((100 * p.done) / p.total).toFixed(1)}%\n${fmtRate(p.rate)}\nthis frame: ${fmtDuration(frameEta)} left`);
      },
      onFrame: (s) => {
        frameRates.push(total / Math.max(s.seconds, 1e-9));
        frameRates = frameRates.slice(-8);
        void previewFrame(s, job.width, job.height);
      },
    });
    const rate = frameRates.length ? frameRates.reduce((a, b) => a + b) / frameRates.length : 0;
    setStatus(
      `${r.rendered} frames rendered, ${r.skipped} already done.${r.stopped ? "\nStopped. Press render to continue." : ""}` +
        (rate ? `\naverage ${fmtRate(rate)}` : ""),
    );
  } catch (e) {
    if ((e as DOMException).name === "AbortError") {
      setStatus(canPickFolder() ? "Stopped. Progress is saved. Press render to continue." : "Stopped.");
      return;
    }
    setStatus(`Render failed: ${(e as Error).message}${canPickFolder() ? "\nFinished frames are kept. Press render to continue." : ""}`);
  } finally {
    device?.destroy();
    setBusy(false);
  }
});

stopBtn.addEventListener("click", () => {
  stopRequested = true;
  abort?.abort();
  setStatus("Stopping after this batch...");
});

// -------------------------------------------------------------- export ----

exportBtn.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  stopRequested = false;
  try {
    const job = await loadJob(store);
    const handle = await pickOutputFile(`${job.name}.mp4`);
    const canvas = new OffscreenCanvas(job.width, job.height);
    const ctx = canvas.getContext("2d")!;
    const rgba = new Uint8ClampedArray(job.width * job.height * 4);
    const image = new ImageData(rgba, job.width, job.height);
    const rec = await startRecording(canvas, { fps: job.fps, width: job.width, height: job.height, timing: "fixed", output: handle });
    try {
      const { frames } = await gradeJob(store, browserZlib, async (f, gray) => {
        if (stopRequested) throw new DOMException("cancelled", "AbortError");
        for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
          rgba[o] = rgba[o + 1] = rgba[o + 2] = gray[i];
          rgba[o + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
        await rec.addFrame(canvas);
        if (f % 10 === 0) showGray(gray, job.width, job.height);
        setStatus(`encoding frame ${f + 1} of ${job.frames} (${rec.codec})`);
      });
      const result = await rec.stop();
      setStatus(`Saved ${handle.name}: ${frames} frames, ${result.duration.toFixed(2)} s, ${result.codec} at ${(result.bitrate / 1e6).toFixed(0)} Mbit/s`);
    } catch (e) {
      await rec.cancel();
      throw e;
    }
  } catch (e) {
    const name = (e as DOMException).name;
    setStatus(name === "AbortError" ? "Export cancelled." : `Export failed: ${(e as Error).message}`);
  } finally {
    setBusy(false);
  }
});
