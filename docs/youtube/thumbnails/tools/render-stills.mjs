// @ts-check
/**
 * Render the stills the thumbnails need beyond the real 1T frames in
 * docs/record, with the real offline renderer (src/offline).
 *
 * The world is the one the record frames come from: `recordJob` from
 * src/record (1000 sheets, seed 1, every particle adds one unit, point
 * splat), frozen at frame 0. That frame is the far opener,
 * docs/record/trillion-still-f0.png: the whole cluster in view. That still was
 * rendered on the first 32-bit keys and this tool renders on the 64-bit ones,
 * so the sheets, camera and instant match but each sheet's particles are a
 * different random draw.
 *
 * Shots:
 *   far     the far opener at --particles. At a smaller count the sheets,
 *           camera and instant are identical and only the grain is coarser,
 *           so it checks the reconstruction against the 1T frame and gives
 *           the per-pixel counts used to pick the loupe pixel. Count
 *           weighted unless --weighting flux, the weighting the record
 *           stills were rendered with (docs/record/README.md).
 *   loupe   the inside of one pixel of the far opener (--pixel x,y), opened
 *           up to 1024 x 1024 with src/proof's loupe (exactly the particles
 *           the main view puts in that pixel), at --particles.
 *           Every dot is one particle, and the frame's GPU tally counts them.
 *           Only the sheets that can reach that pixel are rendered, at their
 *           full counts (see sheetsThroughPixel), so a 1T loupe takes minutes
 *           even on a software GPU and still shows exactly what the whole
 *           trillion puts in that pixel.
 *   loupe-all  the same loupe with every sheet, for checking the cull: at a
 *           small count, loupe and loupe-all must be byte-identical.
 *
 * Run from src/offline so tsx and the webgpu package resolve. In the cloud
 * container Dawn needs SwiftShader's Vulkan driver:
 *
 *   cd src/offline
 *   export VK_ICD_FILENAMES=/opt/pw-browsers/chromium-1243/chrome-linux64/vk_swiftshader_icd.json
 *   T=../../docs/youtube/thumbnails/tools/render-stills.mjs
 *   npx tsx $T                                      # the 1T loupe, about 40 s
 *   npx tsx $T --shots far --particles 4B --out /tmp/far        # about 3 min
 *   npx tsx $T --shots loupe,loupe-all --particles 400M --out /tmp/check
 *
 * Options:
 *   --particles 1T   particles in the world for far and loupe (default 1T;
 *                    the far opener at 1T takes hours on a software GPU)
 *   --shots a,b      only these shots (default loupe)
 *   --pixel x,y      loupe pixel in 3840 x 2160 coordinates (default 2096,921)
 *   --weighting flux the far shot's weighting (default count). The loupe is
 *                    always count weighted, so every particle is one dot.
 *   --out <dir>      output folder (default docs/youtube/thumbnails/stills).
 *                    A folder that holds a different job is refused: delete
 *                    it or pick another folder.
 *   --plan           write each shot's job.json and stop, without a GPU. On a
 *                    machine where Dawn does not run, choose such a folder in
 *                    /src/offline/web/ (Chrome): a folder that already holds a
 *                    job continues that job.
 *   --dawn a=b,c=d   extra Dawn switches, as in the offline runner
 *
 * Output: one folder per shot in the offline renderer's own format (job.json,
 * frame-000000.png as 16-bit log light, frame-000000.json with the GPU
 * tallies). compose.py reads them. Same command, bit-identical frames.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withCommas } from "../../../../src/offline/core/grade";
import { totalParticles } from "../../../../src/offline/core/job";
import { freezeFrame, scaleParticles } from "../../../../src/offline/core/ladder";
import { add, cameraBasis, dot, scale, sub } from "../../../../src/offline/core/math";
import { StatelessRenderer } from "../../../../src/offline/core/renderer";
import { claimDirectory, renderJob } from "../../../../src/offline/core/session";
import { nodeStore, nodeZlib } from "../../../../src/offline/node/platform.mjs";
import { loupeJob } from "../../../../src/proof/shots";
import { parseCount } from "../../../../src/record/index";
import { recordJob } from "../../../../src/record/run";

/** @returns {{ [key: string]: string | true }} */
function parseArgs(argv) {
  /** @type {{ [key: string]: string | true }} */
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

const args = parseArgs(process.argv.slice(2));
const particles = parseCount(String(args.particles ?? "1T"));
const outRoot = typeof args.out === "string" ? path.resolve(args.out) : fileURLToPath(new URL("../stills", import.meta.url));
const [pixelX, pixelY] = String(args.pixel ?? "2096,921").split(",").map(Number);

// The 1T record still exactly as /?record=1e12&size=4k&frames=1 builds it.
// The sheet layout depends on the particle count (1000 sheets at 1T), so the
// world is always built at 1T and only then rescaled.
const opener = freezeFrame(recordJob({ particles: 1e12, width: 3840, height: 2160, frames: 1, fps: 60 }), 0);
const at = (/** @type {number} */ n) => ({ ...scaleParticles(opener, n), name: `thumbnail far opener at ${withCommas(n)}` });

/** @typedef {import("../../../../src/offline/core/job").OfflineJob} OfflineJob */
/** @typedef {import("../../../../src/offline/core/job").OfflinePlane} OfflinePlane */

/** A radius, in sheet-local units, that every position of the law stays inside (see laws.ts). */
function lawReach(/** @type {OfflinePlane} */ p) {
  const k = p.params;
  if (p.law === "kepler") return Math.max(1, Math.abs(k[2])); // apocentre a (1 + ecc) <= 1
  if (p.law === "vortex") return Math.hypot(1 + Math.abs(k[1]), 1) * Math.abs(k[4]);
  return Math.SQRT2 * (1 + Math.abs(k[3])) * Math.abs(k[7]); // lissajous
}

/**
 * The sheets that can put a particle inside pixel (x, y) of the job's frame 0.
 * Every particle of a sheet lies in a ball around its centre; a sheet whose
 * ball misses the pixel's line of sight (a cone two pixels wide, more than
 * the pixel needs) cannot land there. Dropping the others changes nothing in
 * that pixel: a particle's identity is (sheet seed, index in sheet), and
 * integer adds commute. loupe-all checks this.
 */
function sheetsThroughPixel(/** @type {OfflineJob} */ job, /** @type {number} */ x, /** @type {number} */ y) {
  const cam = cameraBasis(job.camera[0]);
  const focal = (0.5 * job.height) / Math.tan(cam.fovY / 2);
  const dx = (x + 0.5 - job.width / 2) / focal;
  const dy = -(y + 0.5 - job.height / 2) / focal;
  const ray = add(add(cam.forward, scale(cam.right, dx)), scale(cam.up, dy));
  const dir = scale(ray, 1 / Math.hypot(ray[0], ray[1], ray[2]));
  const spread = 2 / focal;
  return job.planes.filter((p) => {
    const r = 1.05 * Math.max(p.halfSize[0], p.halfSize[1]) * lawReach(p);
    const c = sub(p.position, cam.eye);
    const t = dot(c, dir);
    const off = sub(c, scale(dir, t));
    return t > -r && Math.hypot(off[0], off[1], off[2]) <= r * (1 + spread) + Math.max(t, 0) * spread;
  });
}

/** @type {Record<string, () => OfflineJob>} */
const SHOTS = {
  far: () => ({ ...at(particles), weighting: args.weighting === "flux" ? "flux" : "count" }),
  loupe: () => {
    const world = at(particles);
    const job = loupeJob({ ...world, planes: sheetsThroughPixel(world, pixelX, pixelY) }, pixelX, pixelY, 1024);
    return { ...job, name: `thumbnail loupe ${pixelX},${pixelY} at ${withCommas(particles)}` };
  },
  "loupe-all": () => ({ ...loupeJob(at(particles), pixelX, pixelY, 1024), name: `thumbnail loupe ${pixelX},${pixelY} at ${withCommas(particles)}` }),
};

const instances = [];
async function openDevice(job) {
  // The webgpu package (Dawn) is installed in src/offline, not at the repo root.
  const offlineRequire = createRequire(new URL("../../../../src/offline/package.json", import.meta.url));
  const { create, globals } = await import(pathToFileURL(offlineRequire.resolve("webgpu")).href);
  Object.assign(globalThis, globals);
  const gpu = create(typeof args.dawn === "string" ? args.dawn.split(",") : []);
  instances.push(gpu);
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No GPU adapter found. In the cloud container set VK_ICD_FILENAMES (see the header).");
  instances.push(adapter);
  const device = await adapter.requestDevice({ requiredLimits: StatelessRenderer.requiredLimits(job, adapter) });
  device.addEventListener("uncapturederror", (e) => console.error("GPU error:", /** @type {any} */ (e).error?.message ?? e));
  const info = adapter.info;
  return { device, name: [info.vendor, info.device, info.description].filter(Boolean).join(" ") };
}

const wanted = typeof args.shots === "string" ? args.shots.split(",") : ["loupe"];
for (const name of wanted) {
  if (!SHOTS[name]) throw new Error(`Unknown shot "${name}". Shots: ${Object.keys(SHOTS).join(", ")}`);
  const job = SHOTS[name]();
  const dir = path.join(outRoot, name);
  const store = nodeStore(dir);
  const what = `${name}: ${withCommas(totalParticles(job))} particles on ${job.planes.length} sheets, ${job.width}x${job.height}, ${job.weighting}, ${job.splat}`;
  if (args.plan) {
    await claimDirectory(store, job);
    console.log(`${what}: wrote ${path.join(dir, "job.json")}`);
    continue;
  }
  const { device, name: adapter } = await openDevice(job);
  console.log(`${what}, on ${adapter}`);
  let last = 0;
  await renderJob(device, job, store, nodeZlib, {
    checkpointSeconds: 300,
    onProgress: (p) => {
      const t = performance.now();
      if (t - last < 2000) return;
      last = t;
      process.stdout.write(`\r  ${((100 * p.done) / p.total).toFixed(0)}%   `);
    },
    onFrame: (s) =>
      console.log(`\r  ${s.seconds.toFixed(1)} s, ${withCommas(s.landed)} particles landed in view, ${withCommas(s.litPixels)} lit pixels`),
  });
  device.destroy();
}
process.exit(0);
