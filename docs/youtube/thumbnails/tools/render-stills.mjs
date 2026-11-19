// @ts-check
/**
 * Render the source stills for the YouTube thumbnails with the real offline
 * renderer (src/offline), in the same world and on the same camera path as the
 * 1 trillion particle clip (preset "trillion": seed 1, 1024 sheets, 4K).
 *
 * Run from src/offline so tsx and the webgpu package resolve:
 *
 *   cd src/offline
 *   npx tsx ../../docs/youtube/thumbnails/tools/render-stills.mjs --particles 1T
 *
 * Options:
 *   --particles 1T       particles in the world (default 1T). A smaller count
 *                        keeps the exact same world and camera and spreads
 *                        fewer particles over it: a faster, noisier stand-in.
 *   --out <dir>          output folder (default out/thumbnail-stills)
 *   --shots a,b,c        render only these shots (default all, see SHOTS)
 *   --frames 0,90,180    also render these clip frames (for picking new shots)
 *   --width --height     output size (default 3840 x 2160). The camera path is
 *                        always built at 4K so it matches the video.
 *   --pixel x,y          the pixel of the "hero" frame that the "pixel" shots
 *                        zoom into, in 3840 x 2160 coordinates
 *   --dawn backend=vulkan  extra Dawn switches, as in the offline runner
 *
 * Output: one folder per shot, each in the offline renderer's own format
 * (job.json, frame-000000.png as 16-bit log light, frame-000000.json stats),
 * plus clip/ for the clip frames. compose.py reads these folders. Everything
 * is deterministic: the same command gives bit-identical frames.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CameraPath } from "../../../../src/offline/core/camera";
import { cameraBasis } from "../../../../src/offline/core/math";
import { StatelessRenderer } from "../../../../src/offline/core/renderer";
import { renderJob } from "../../../../src/offline/core/session";
import { PRESETS, clusterJob } from "../../../../src/offline/core/world";
import { withCommas } from "../../../../src/offline/core/grade";
import { nodeStore, nodeZlib } from "../../../../src/offline/node/platform.mjs";

// The webgpu package (Dawn) is installed in src/offline, not at the repo root.
const offlineRequire = createRequire(new URL("../../../../src/offline/package.json", import.meta.url));
const { create, globals } = await import(pathToFileURL(offlineRequire.resolve("webgpu")).href);
Object.assign(globalThis, globals);

// ------------------------------------------------------------------ args ----

/** @returns {{ [key: string]: any }} */
function parseArgs(argv) {
  /** @type {{ [key: string]: any }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

/** Accepts 1e12, 1_000_000, 250M, 1B, 1T. */
function parseCount(v) {
  const s = String(v).replace(/[_,]/g, "").toUpperCase();
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[s.slice(-1)];
  const n = mult ? Number(s.slice(0, -1)) * mult : Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Not a count: ${v}`);
  return Math.round(n);
}

const args = parseArgs(process.argv.slice(2));
const particles = parseCount(args.particles ?? "1T");
const width = Number(args.width ?? 3840);
const height = Number(args.height ?? 2160);
const outRoot = path.resolve(String(args.out ?? path.join("out", "thumbnail-stills")));

// --------------------------------------------------------------- the clip ----

/**
 * The 1T clip exactly as `cli.mjs render --preset trillion` builds it. The
 * camera path depends on the particle count and the resolution (the last key
 * stops where single particles resolve at 4K), so it is always built from
 * the full preset and only then thinned out and resized.
 */
const reference = clusterJob(PRESETS.trillion);
const referenceTotal = reference.planes.reduce((s, p) => s + p.particleCount, 0);

/** Spread `total` particles over the reference sheets in the same proportions. */
function scaledPlanes(total) {
  const planes = reference.planes.map((p) => ({ ...p, particleCount: Math.floor((p.particleCount * total) / referenceTotal) }));
  let rest = total - planes.reduce((s, p) => s + p.particleCount, 0);
  for (let i = 0; rest > 0; i = (i + 1) % planes.length, rest--) planes[i].particleCount++;
  return planes;
}

/** The clip itself, thinned to `total` particles. Frame f here is frame f of the video. */
function clipJob(total) {
  return {
    ...reference,
    name: total === referenceTotal ? reference.name : `${reference.name}-at-${total}`,
    width,
    height,
    planes: scaledPlanes(total),
  };
}

const clipPath = new CameraPath(reference.camera);
/** Frame `f` of the clip as a job of its own: same pose, same instant, one frame. */
function stillOf(f, total, overrides = {}) {
  const pose = clipPath.atFrame(f, reference.frames);
  return {
    ...clipJob(total),
    name: `frame-${f}`,
    frames: 1,
    timeOffset: reference.timeOffset + (f / reference.fps) * reference.timeScale,
    camera: [{ t: 0, ...pose }],
    ...overrides,
  };
}

/**
 * Aim the camera through one pixel of a clip frame. The eye stays where it
 * is; the view turns to that pixel's centre and the field of view narrows to
 * `span` pixels of the 4K frame. With a square output and span 1, the image
 * is the inside of exactly one pixel.
 */
function throughPixel(f, px, py, span) {
  const pose = clipPath.atFrame(f, reference.frames);
  const cam = cameraBasis(pose);
  const focal = (0.5 * 2160) / Math.tan(pose.fovY / 2);
  const dx = (px + 0.5 - 1920) / focal;
  const dy = (py + 0.5 - 1080) / focal;
  const ray = [0, 1, 2].map((i) => cam.forward[i] + cam.right[i] * dx - cam.up[i] * dy);
  const len = Math.hypot(ray[0], ray[1], ray[2]);
  const fwd = ray.map((v) => v / len);
  const pitch = Math.asin(fwd[1]);
  const yaw = Math.atan2(-fwd[0], -fwd[2]);
  const d = pose.distance;
  return {
    t: 0,
    target: /** @type {[number, number, number]} */ ([0, 1, 2].map((i) => cam.eye[i] + fwd[i] * d)),
    yaw,
    pitch,
    distance: d,
    fovY: 2 * Math.atan(Math.tan(pose.fovY / 2) * (span / 2160)),
  };
}

// ---------------------------------------------------------------- shots ----

/**
 * Frames of the clip (600 frames, 4K60) used as thumbnail sources:
 *   wide  frame 0, the opening: the whole world in view, every particle in frame
 *   hero  frame 432, the hero sheet's spiral filling the left of the frame
 *   dive  frame 516, low over the hero sheet, where particles start to separate
 */
const FRAME = { wide: 0, hero: 432, dive: 516 };
const [pixelX, pixelY] = String(args.pixel ?? "1416,1203").split(",").map(Number);

/** @type {Record<string, () => any>} */
const SHOTS = {
  wide: () => stillOf(FRAME.wide, particles),
  hero: () => stillOf(FRAME.hero, particles),
  dive: () => stillOf(FRAME.dive, particles),
  // The same frames with Noah's previous record count, 4,000,000 particles.
  "record-wide": () => stillOf(FRAME.wide, 4_000_000),
  "record-hero": () => stillOf(FRAME.hero, 4_000_000),
  // Inside one pixel of the hero frame, at 1024 x 1024. "pixel" is lit the
  // way the frame is (flux); "pixel-count" counts every particle once, so
  // its stats hold the exact number of particles inside that pixel.
  "pixel": () => ({ ...stillOf(FRAME.hero, particles), width: 1024, height: 1024, camera: [throughPixel(FRAME.hero, pixelX, pixelY, 1)] }),
  "pixel-count": () => ({
    ...stillOf(FRAME.hero, particles),
    width: 1024,
    height: 1024,
    weighting: "count",
    camera: [throughPixel(FRAME.hero, pixelX, pixelY, 1)],
  }),
  // The opening frame with a single particle in the world, counted, so its
  // stats say exactly 1 in view.
  one: () => ({ ...stillOf(FRAME.wide, 1), weighting: "count" }),
};

// ------------------------------------------------------------------ gpu ----

const instances = [];
async function openDevice(job) {
  const gpu = create(args.dawn ? String(args.dawn).split(",") : []);
  instances.push(gpu);
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  instances.push(adapter);
  if (!adapter) throw new Error("No GPU adapter found. Try --dawn backend=vulkan.");
  const device = await adapter.requestDevice({ requiredLimits: StatelessRenderer.requiredLimits(job, adapter) });
  device.addEventListener("uncapturederror", (e) => console.error("GPU error:", e.error?.message ?? e));
  const info = adapter.info;
  return { device, name: [info.vendor, info.device, info.description].filter(Boolean).join(" ") };
}

async function renderInto(dir, job, frames) {
  const store = nodeStore(dir);
  const { device, name } = await openDevice(job);
  const total = job.planes.reduce((s, p) => s + p.particleCount, 0);
  console.log(`${path.basename(dir)}: ${withCommas(total)} particles, ${job.width}x${job.height}, ${job.weighting}, on ${name}`);
  for (const f of frames) {
    let last = 0;
    await renderJob(device, job, store, nodeZlib, {
      first: f,
      end: f + 1,
      checkpointSeconds: 300,
      onProgress: (p) => {
        const t = performance.now();
        if (t - last < 2000) return;
        last = t;
        process.stdout.write(`\r  frame ${p.frame}: ${((100 * p.done) / p.total).toFixed(0)}%   `);
      },
      onFrame: (s) =>
        process.stdout.write(
          `\r  frame ${s.frame}: ${s.seconds.toFixed(1)} s, ${withCommas(s.litPixels)} lit pixels${s.inView ? `, ${withCommas(s.inView)} in view` : ""}\n`,
        ),
    });
  }
  device.destroy();
}

const wanted = args.shots ? String(args.shots).split(",") : args.frames ? [] : Object.keys(SHOTS);
for (const name of wanted) {
  if (!SHOTS[name]) throw new Error(`Unknown shot "${name}". Shots: ${Object.keys(SHOTS).join(", ")}`);
  await renderInto(path.join(outRoot, name), SHOTS[name](), [0]);
}
if (args.frames) {
  const frames = String(args.frames).split(",").map(Number);
  await renderInto(path.join(outRoot, "clip"), clipJob(particles), frames);
}
process.exit(0);
