/**
 * Proof shots page. Renders the shots in ../shots.ts with the offline
 * renderer (renderJob) and exports an MP4 with the GPU-counted numbers burned
 * in. Open /src/proof/web/ under `npm run dev`. Choose a folder first for
 * trillion renders: frames land on disk and a render resumes after a reload.
 */
import { pickOutputFile, startRecording } from "../../capture";
import type { FrameStats } from "../../offline/core/develop";
import { totalParticles, type OfflineJob } from "../../offline/core/job";
import { cameraBasis } from "../../offline/core/math";
import { CameraPath } from "../../offline/core/camera";
import { StatelessRenderer } from "../../offline/core/renderer";
import { gradeJob, renderJob, type FileStore } from "../../offline/core/session";
import { browserZlib, canPickFolder, directoryStore, memoryStore, pickFolder } from "../../offline/web/platform";
import {
  baseWorld,
  countUpLabel,
  countUpPasses,
  diveJob,
  diveLabel,
  findJob,
  findLabel,
  loupeJob,
  loupeLabel,
  particlePosition,
  project,
  pullBackLabel,
  pullBackPasses,
  rollPixel,
  type Pass,
  type ShotOptions,
} from "../shots";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLPreElement>("status");
const view = $<HTMLCanvasElement>("view");
const setStatus = (s: string) => (statusEl.textContent = s);
const num = (id: string) => Number($<HTMLInputElement>(id).value.replace(/[_,\s]/g, ""));

let store: FileStore = memoryStore();
let stopRequested = false;
let busy = false;

function options(): ShotOptions {
  return {
    particles: num("particles"),
    width: num("width"),
    height: num("height"),
    fps: num("fps"),
    seed: num("seed"),
    dice: num("dice"),
    findIndex: num("find"),
  };
}
const shot = () => $<HTMLSelectElement>("shot").value;

/** Files of one pass live in the shot folder under a name prefix. */
function prefixed(base: FileStore, prefix: string): FileStore {
  return {
    read: (n) => base.read(prefix + n),
    write: (n, d) => base.write(prefix + n, d),
    remove: (n) => base.remove(prefix + n),
  };
}

const text = new TextEncoder();
const untext = new TextDecoder();

/** The passes of the current shot. The loupe's second pass depends on its first and is added later. */
function passes(o: ShotOptions): Pass[] {
  switch (shot()) {
    case "countUp":
      return countUpPasses(o);
    case "pullBack":
      return pullBackPasses(o, num("pull"));
    case "dive":
      return [{ key: "dive-", job: diveJob(o), hold: 1 }];
    case "find":
      return [{ key: "find-", job: findJob(o), hold: 1 }];
    case "loupe":
      return [];
  }
  throw new Error("unknown shot");
}

async function openDevice(job: OfflineJob): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error("WebGPU is not available. Use Chrome or Edge.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No GPU adapter found.");
  return adapter.requestDevice({ requiredLimits: StatelessRenderer.requiredLimits(job, adapter) });
}

const fmtRate = (r: number) => `${(r / 1e9).toFixed(2)} billion/s`;

async function renderPass(device: GPUDevice, pass: Pass, i: number, n: number): Promise<boolean> {
  const r = await renderJob(device, pass.job, prefixed(store, pass.key), browserZlib, {
    targetBatchMs: 120,
    checkpointSeconds: canPickFolder() ? 120 : 0,
    shouldStop: () => stopRequested,
    onProgress: (p) =>
      setStatus(`pass ${i + 1} of ${n}, frame ${p.frame + 1} of ${pass.job.frames}: ${((100 * p.done) / Math.max(p.total, 1)).toFixed(1)}%\n${fmtRate(p.rate)}`),
  });
  return !r.stopped;
}

/** Loupe: render the full frame, read one pixel's exact 64-bit count, then render that pixel opened up. */
async function renderLoupe(device: GPUDevice, o: ShotOptions): Promise<void> {
  const main = baseWorld(o);
  let pixel = await store.read("loupe-pixel.json").then((f) => (f ? JSON.parse(untext.decode(f)) : null));
  if (!pixel) {
    // Exact counts need the raw grid, so the main frame uses the renderer directly.
    const renderer = await StatelessRenderer.create(device, main, { targetBatchMs: 120 });
    const res = await renderer.renderFrame(0, {
      signal: undefined,
      onProgress: (d, t, b, ms) => setStatus(`loupe main frame: ${((100 * d) / t).toFixed(1)}%\n${fmtRate(b / Math.max(ms / 1000, 1e-6))}`),
    });
    renderer.dispose();
    const p = rollPixel(res.lo, res.hi, main.width, main.height, o.dice);
    pixel = { x: p.x, y: p.y, count: p.count.toString(), landed: res.landed.toString(), evaluated: res.evaluated };
    await store.write("loupe-pixel.json", text.encode(JSON.stringify(pixel)));
  }
  const size = Math.min(o.height, 2160);
  await renderPass(device, { key: "loupe-", job: loupeJob(main, pixel.x, pixel.y, size), hold: 1 }, 1, 2);
  setStatus(`Loupe pixel (${pixel.x}, ${pixel.y}) holds ${pixel.count} particles (GPU count). Export to see it opened up.`);
}

$<HTMLButtonElement>("folder").addEventListener("click", async () => {
  try {
    const dir = await pickFolder();
    store = directoryStore(dir);
    setStatus(`Frames will be saved in "${dir.name}". Use one folder per shot.`);
  } catch (e) {
    if ((e as DOMException).name !== "AbortError") setStatus((e as Error).message);
  }
});

$<HTMLButtonElement>("render").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  stopRequested = false;
  $<HTMLButtonElement>("stop").disabled = false;
  let device: GPUDevice | null = null;
  try {
    const o = options();
    device = await openDevice(baseWorld(o));
    if (shot() === "loupe") {
      await renderLoupe(device, o);
    } else {
      const list = passes(o);
      const t0 = performance.now();
      for (let i = 0; i < list.length; i++) if (!(await renderPass(device, list[i], i, list.length))) break;
      await store.write(`${shot()}-seconds.json`, text.encode(String((performance.now() - t0) / 1000)));
      setStatus(stopRequested ? "Stopped. Render again to continue." : `Done: ${list.length} passes. Export to make the MP4.`);
    }
  } catch (e) {
    setStatus(`Render failed: ${(e as Error).message}`);
  } finally {
    device?.destroy();
    busy = false;
    $<HTMLButtonElement>("stop").disabled = true;
  }
});

$<HTMLButtonElement>("stop").addEventListener("click", () => {
  stopRequested = true;
  setStatus("Stopping after this batch...");
});

/** A thin ring around a tracked particle, drawn into the graded frame. */
function ring(gray: Uint8Array, w: number, h: number, cx: number, cy: number, r: number): void {
  for (let a = 0; a < 720; a++) {
    const t = (a / 720) * Math.PI * 2;
    const x = Math.round(cx + r * Math.cos(t));
    const y = Math.round(cy + r * Math.sin(t));
    if (x >= 0 && y >= 0 && x < w && y < h) gray[y * w + x] = 255;
  }
}

$<HTMLButtonElement>("export").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  try {
    const o = options();
    const id = shot();
    const list: Pass[] =
      id === "loupe"
        ? [{ key: "loupe-", job: loupeJob(baseWorld(o), 0, 0, Math.min(o.height, 2160)), hold: Math.round(o.fps * 5) }]
        : passes(o);
    const first = list[0].job;
    const width = first.width;
    const height = first.height;
    const handle = await pickOutputFile(`proof-${id}.mp4`);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const image = new ImageData(rgba, width, height);
    const preview = view.getContext("2d")!;
    const rec = await startRecording(canvas, { fps: o.fps, width, height, timing: "fixed", output: handle });
    const secondsFile = await store.read(`${id}-seconds.json`);
    const seconds = secondsFile ? Number(untext.decode(secondsFile)) : NaN;
    const pixelFile = await store.read("loupe-pixel.json");
    const pixel = pixelFile ? JSON.parse(untext.decode(pixelFile)) : null;
    const findTarget = id === "find" ? particlePosition(first, o.findIndex, first.timeOffset) : null;
    let written = 0;
    try {
      for (const pass of list) {
        const label = (s: FrameStats, job: OfflineJob): string[] => {
          if (id === "countUp") return countUpLabel(s, job, seconds, list.length);
          if (id === "pullBack") return pullBackLabel(s);
          if (id === "dive") return diveLabel(s);
          if (id === "find") return findLabel(s, o.findIndex, job);
          return pixel ? loupeLabel({ x: pixel.x, y: pixel.y, count: BigInt(pixel.count) }, s.landed) : [];
        };
        await gradeJob(prefixed(store, pass.key), browserZlib, async (f, gray, job) => {
          if (findTarget) {
            const cam = cameraBasis(new CameraPath(job.camera).atFrame(f, job.frames));
            const p = project(cam, findTarget, job.width, job.height);
            if (p) ring(gray, job.width, job.height, p.x, p.y, Math.max(12, job.height / 60));
          }
          for (let i = 0, k = 0; i < gray.length; i++, k += 4) {
            rgba[k] = rgba[k + 1] = rgba[k + 2] = gray[i];
            rgba[k + 3] = 255;
          }
          ctx.putImageData(image, 0, 0);
          for (let hold = 0; hold < pass.hold; hold++) await rec.addFrame(canvas);
          written += pass.hold;
          if (view.width !== width) {
            view.width = width;
            view.height = height;
          }
          preview.putImageData(image, 0, 0);
          setStatus(`encoding: ${written} video frames (${rec.codec})`);
        }, { label });
      }
      const result = await rec.stop();
      setStatus(`Saved ${handle.name}: ${result.duration.toFixed(2)} s, ${result.codec}. Total in world: ${totalParticles(baseWorld(o))}`);
    } catch (e) {
      await rec.cancel();
      throw e;
    }
  } catch (e) {
    setStatus(`Export failed: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
});

if (!canPickFolder()) setStatus("This browser cannot write to a folder: frames stay in memory. Use Chrome or Edge for trillion renders.");
