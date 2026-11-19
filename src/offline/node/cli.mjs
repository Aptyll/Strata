// @ts-check
/**
 * Strata offline runner for Node. Uses Dawn (the `webgpu` package) for the
 * GPU and the system ffmpeg for encoding. Run with tsx, see ../README.md.
 *
 *   bench   measure particles per second on this machine
 *   render  render missing frames of a job (resumable)
 *   encode  grade the rendered frames and encode an MP4
 *   still   grade one frame to an 8-bit PNG
 *   ladder  render one frame at 1M, 100M, 10B and 1T particles, with timings
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { create, globals } from "webgpu";

import { totalParticles } from "../core/job";
import { DEFAULT_RUNGS, ladderJobs, ladderMarkdown, ladderReport } from "../core/ladder";
import { encodeGrayPng } from "../core/png";
import { StatelessRenderer } from "../core/renderer";
import { gradeJob, loadJob, loadStats, renderJob } from "../core/session";
import { PRESETS, clusterJob } from "../core/world";
import { COMPOSITIONS } from "../core/compositions";
import { DEFAULT_LOOK, exposureTrack, withCommas } from "../core/grade";
import { nodeStore, nodeZlib } from "./platform.mjs";

Object.assign(globalThis, globals);

// ------------------------------------------------------------------ args ----

/** @returns {{ _: string[], [key: string]: any }} */
function parseArgs(argv) {
  /** @type {{ _: string[], [key: string]: any }} */
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
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
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`);
  return Math.round(n);
}

function jobFromArgs(args) {
  const presetName = args.preset ?? "smoke";
  const composition = COMPOSITIONS[presetName];
  const preset = composition?.defaults ?? PRESETS[presetName];
  if (!preset) throw new Error(`Unknown preset "${presetName}". Choose from: ${[...Object.keys(PRESETS), ...Object.keys(COMPOSITIONS)].join(", ")}`);
  const o = { ...preset };
  if (args.name) o.name = String(args.name);
  if (args.width) o.width = parseCount(args.width);
  if (args.height) o.height = parseCount(args.height);
  if (args.fps) o.fps = Number(args.fps);
  if (args.frames) o.frames = parseCount(args.frames);
  if (args.seconds) o.frames = Math.round(Number(args.seconds) * o.fps);
  if (args.particles) o.particles = parseCount(args.particles);
  if (args.planes) o.planes = parseCount(args.planes);
  if (args.seed) o.seed = parseCount(args.seed);
  if (args.ssaa) o.ssaa = parseCount(args.ssaa);
  if (args.splat) o.splat = args.splat;
  if (args.weighting) o.weighting = args.weighting;
  if (args["time-scale"]) o.timeScale = Number(args["time-scale"]);
  if (args.shutter !== undefined) o.shutter = Number(args.shutter);
  return composition ? composition.build(o) : clusterJob(o);
}

const rendererOptions = (args) => ({
  perInvocation: args["per-invocation"] ? parseCount(args["per-invocation"]) : undefined,
  targetBatchMs: args["batch-ms"] ? Number(args["batch-ms"]) : undefined,
  maxBatch: args["max-batch"] ? parseCount(args["max-batch"]) : undefined,
});

// ------------------------------------------------------------------- gpu ----

// Dawn instances and adapters must stay referenced for as long as their
// devices are in use. If one is garbage collected, the process aborts.
const instances = [];

async function openDevice(args, job) {
  // Extra Dawn switches, for example --dawn backend=vulkan
  const flags = args.dawn ? String(args.dawn).split(",") : [];
  const gpu = create(flags);
  instances.push(gpu);
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  instances.push(adapter);
  if (!adapter) throw new Error("No GPU adapter found. Update your graphics driver, or try --dawn backend=vulkan.");
  const info = adapter.info;
  const name = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" ") || "unknown adapter";
  const device = await adapter.requestDevice({ requiredLimits: job ? StatelessRenderer.requiredLimits(job, adapter) : {} });
  device.addEventListener("uncapturederror", (e) => console.error("GPU error:", e.error?.message ?? e));
  return { device, name };
}

const fmtRate = (r) => (r >= 1e9 ? `${(r / 1e9).toFixed(2)} B/s` : `${(r / 1e6).toFixed(1)} M/s`);
function fmtDuration(s) {
  if (!Number.isFinite(s)) return "?";
  if (s < 90) return `${s.toFixed(1)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

// ----------------------------------------------------------------- bench ----

async function bench(args) {
  const seconds = Number(args.seconds ?? 4);
  delete args.seconds;
  const base = jobFromArgs({ preset: "smoke", width: 3840, height: 2160, ...args });
  const { device, name } = await openDevice(args, base);
  console.log(`Adapter: ${name}`);
  console.log(`Grid: ${base.width * base.ssaa} x ${base.height * base.ssaa}. Measuring about ${seconds} s per case.\n`);
  const results = [];
  for (const splat of ["point", "bilinear"]) {
    for (const law of ["kepler", "vortex", "lissajous"]) {
      // One sheet facing the camera, big enough to keep the GPU busy.
      const plane = base.planes.find((p) => p.law === law) ?? base.planes[0];
      const job = {
        ...base,
        splat,
        frames: 1,
        planes: [{ ...plane, law, position: [0, 0, 0], rotation: [0, 0, 0, 1], halfSize: [1, 1], particleCount: 0xffffffff }],
        camera: [{ t: 0, target: [0, 0, 0], yaw: 0, pitch: 0, distance: 3.2, fovY: 0.7 }],
        fluxRef: 1,
        near: 0.01,
      };
      const renderer = await StatelessRenderer.create(device, /** @type {any} */ (job), rendererOptions(args));
      // Stop the frame by throwing from the progress hook once time is up.
      const start = performance.now();
      let done = 0;
      let warm = 0;
      let warmAt = start;
      try {
        await renderer.renderFrame(0, {
          onProgress: (d) => {
            done = d;
            const t = performance.now();
            // The first second is warm-up while the batch size settles.
            if (warm === 0 && t - start > 1000) {
              warm = d;
              warmAt = t;
            }
            if (t - start > (seconds + 1) * 1000) throw new Error("bench-stop");
          },
        });
      } catch (e) {
        if (/** @type {Error} */ (e).message !== "bench-stop") throw e;
      }
      const rate = (done - warm) / ((performance.now() - warmAt) / 1000);
      renderer.dispose();
      results.push({ law, splat, rate });
      console.log(`${law.padEnd(10)} ${splat.padEnd(9)} ${fmtRate(rate).padStart(12)}   1T frame: ${fmtDuration(1e12 / rate)}   1B frame: ${fmtDuration(1e9 / rate)}`);
    }
  }
  const point = results.filter((r) => r.splat === "point");
  const mean = point.reduce((s, r) => s + r.rate, 0) / point.length;
  console.log(`\nAt the point-splat average of ${fmtRate(mean)}:`);
  for (const [label, n, frames] of [["1B, 30 s at 60 fps", 1e9, 1800], ["1T, 10 s at 60 fps", 1e12, 600], ["1T, 10 s at 30 fps", 1e12, 300]]) {
    console.log(`  ${String(label).padEnd(20)} ${fmtDuration((Number(n) / mean) * Number(frames))}`);
  }
  device.destroy();
}

// ---------------------------------------------------------------- render ----

async function render(args) {
  const job = jobFromArgs(args);
  const out = path.resolve(String(args.out ?? path.join("out", job.name)));
  const store = nodeStore(out);
  const total = totalParticles(job);
  console.log(`Job "${job.name}": ${withCommas(total)} particles on ${job.planes.length} sheets, ${job.width}x${job.height}, ${job.frames} frames at ${job.fps} fps`);
  console.log(`Output: ${out}`);

  let stop = false;
  process.on("SIGINT", () => {
    if (stop) process.exit(130);
    stop = true;
    console.log("\nStopping after this batch. Progress is saved. Press Ctrl+C again to quit now.");
  });

  const [first, end] = args.frame !== undefined ? [Number(args.frame), Number(args.frame) + 1] : String(args.range ?? "").includes(":") ? String(args.range).split(":").map(Number) : [undefined, undefined];
  const [shardIndex, shardCount] = args.shard ? String(args.shard).split("/").map(Number) : [0, 1];

  // A lost device (driver reset, sleep) is retried a few times from the last checkpoint.
  for (let attempt = 0; ; attempt++) {
    const { device, name } = await openDevice(args, job);
    if (attempt === 0) console.log(`Adapter: ${name}\n`);
    let lastPrint = 0;
    try {
      const r = await renderJob(device, job, store, nodeZlib, {
        ...rendererOptions(args),
        first,
        end,
        shardIndex,
        shardCount,
        checkpointSeconds: args.checkpoint !== undefined ? Number(args.checkpoint) : 300,
        shouldStop: () => stop,
        onProgress: (p) => {
          const t = performance.now();
          if (t - lastPrint < 1000) return;
          lastPrint = t;
          const eta = (p.total - p.done) / Math.max(p.rate, 1);
          process.stdout.write(`\rframe ${p.frame}: ${((100 * p.done) / p.total).toFixed(1)}%  ${fmtRate(p.rate)}  batch ${withCommas(p.batchSize)} in ${p.batchMs.toFixed(0)} ms  frame eta ${fmtDuration(eta)}      `);
        },
        onFrame: (s, resumed) => {
          const rate = Number(s.evaluated) / Math.max(s.seconds, 1e-9);
          process.stdout.write(`\rframe ${s.frame} done in ${fmtDuration(s.seconds)}${resumed ? " (resumed)" : `, ${fmtRate(rate)}`}, ${withCommas(s.litPixels)} lit pixels, ${withCommas(s.landed)} in frame                    \n`);
        },
      });
      console.log(`\nRendered ${r.rendered} frames, ${r.skipped} were already done.${r.stopped ? " Stopped early: run the same command to continue." : ""}`);
      device.destroy();
      return;
    } catch (e) {
      const message = /** @type {Error} */ (e).message ?? String(e);
      if (!/device lost/i.test(message) || attempt >= 5 || stop) throw e;
      console.log(`\n${message}. Reopening the GPU and resuming (attempt ${attempt + 1} of 5).`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---------------------------------------------------------------- encode ----

function lookFromArgs(args) {
  /** @type {Record<string, number>} */
  const look = {};
  if (args.white) look.white = Number(args.white);
  if (args.contrast) look.contrast = Number(args.contrast);
  if (args.gamma) look.gamma = Number(args.gamma);
  if (args.percentile) look.whitePercentile = Number(args.percentile);
  if (args.headroom) look.headroomStops = Number(args.headroom);
  if (args.smooth !== undefined) look.smoothFrames = Number(args.smooth);
  return look;
}

function labelFromArgs(args) {
  if (args["no-label"]) return [];
  if (typeof args.label === "string") return args.label.split("|");
  return undefined;
}

async function encode(args) {
  const out = path.resolve(String(args.out ?? "out/smoke"));
  const store = nodeStore(out);
  const job = await loadJob(store);
  const stats = await loadStats(store, job);
  if (stats.length === 0) throw new Error("No completed frames yet.");
  if (stats.length < job.frames) console.log(`Only frames 0 to ${stats.length - 1} of ${job.frames} are complete. Encoding those.`);

  const ffmpeg = String(args.ffmpeg ?? "ffmpeg");
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) {
    throw new Error("ffmpeg was not found. Install it (https://ffmpeg.org/download.html) or pass --ffmpeg <path>.");
  }
  const file = path.resolve(String(args.file ?? path.join(out, `${job.name}.mp4`)));
  const hevc = args.codec === "hevc";
  const codecArgs = hevc
    ? ["-c:v", "libx265", "-preset", String(args["x-preset"] ?? "medium"), "-crf", String(args.crf ?? 16), "-tag:v", "hvc1"]
    : ["-c:v", "libx264", "-preset", String(args["x-preset"] ?? "slow"), "-crf", String(args.crf ?? 14)];
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "gray", "-video_size", `${job.width}x${job.height}`, "-framerate", String(job.fps),
      "-i", "-",
      ...codecArgs,
      "-pix_fmt", "yuv420p",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
      "-movflags", "+faststart",
      file,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  let failed = null;
  child.on("error", (e) => (failed = e));
  child.stdin.on("error", (e) => (failed = e));

  const t0 = performance.now();
  const { frames } = await gradeJob(
    store,
    nodeZlib,
    async (f, gray) => {
      if (failed) throw failed;
      if (!child.stdin.write(gray)) await once(child.stdin, "drain");
      process.stdout.write(`\rencoding frame ${f + 1} of ${stats.length}   `);
    },
    { look: lookFromArgs(args), label: labelFromArgs(args) },
  );
  child.stdin.end();
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
  console.log(`\nWrote ${file}: ${frames} frames, ${(frames / job.fps).toFixed(2)} s, in ${fmtDuration((performance.now() - t0) / 1000)}`);
}

async function still(args) {
  const out = path.resolve(String(args.out ?? "out/smoke"));
  const store = nodeStore(out);
  const frame = Number(args.frame ?? 0);
  let done = false;
  await gradeJob(
    store,
    nodeZlib,
    async (f, gray, job) => {
      const name = `still-${String(f).padStart(6, "0")}.png`;
      await store.write(name, await encodeGrayPng(gray, job.width, job.height, nodeZlib));
      console.log(`Wrote ${path.join(out, name)}`);
      done = true;
    },
    { look: lookFromArgs(args), label: labelFromArgs(args) },
    { first: frame, end: frame + 1 },
  );
  if (!done) throw new Error(`Frame ${frame} is not rendered yet.`);
}

// ---------------------------------------------------------------- ladder ----

/**
 * The same frame at 1M, 100M, 10B and 1T particles (or --rungs). Each rung is
 * its own resumable one-frame job in out/<rung>/, graded to out/<rung>.png.
 * Exposure is locked per particle by default: the largest rung picks its white
 * point (or --white), and every other rung uses that white scaled by its count,
 * so the rungs share one mean brightness and differ only in grain. Pass
 * --exposure auto to expose each rung on its own. ladder.md and ladder.json
 * report the GPU time and throughput of every rung.
 */
async function ladder(args) {
  const base = jobFromArgs({ preset: "trillion", ...args });
  const frame = Number(args.frame ?? 0);
  const rungs = args.rungs ? String(args.rungs).split(",").map(parseCount) : DEFAULT_RUNGS;
  const steps = ladderJobs(base, frame, rungs);
  const out = path.resolve(String(args.out ?? path.join("out", `${base.name}-ladder`)));
  const root = nodeStore(out);
  console.log(`Ladder of "${base.name}" frame ${frame}: ${steps.map((s) => s.label).join(", ")} at ${base.width}x${base.height}`);
  console.log(`Output: ${out}`);

  const abort = new AbortController();
  process.on("SIGINT", () => {
    if (abort.signal.aborted) process.exit(130);
    abort.abort();
    console.log("\nStopping after this batch. Progress is saved. Run the same command to continue.");
  });

  // Every rung has the same grid, so one device fits them all.
  const { device, name } = await openDevice(args, steps[steps.length - 1].job);
  console.log(`Adapter: ${name}\n`);
  /** @type {{ step: (typeof steps)[number], store: ReturnType<typeof nodeStore>, stats: any }[]} */
  const done = [];
  try {
    for (const step of steps) {
      const store = nodeStore(path.join(out, step.label));
      let lastPrint = 0;
      await renderJob(device, step.job, store, nodeZlib, {
        ...rendererOptions(args),
        signal: abort.signal,
        checkpointSeconds: args.checkpoint !== undefined ? Number(args.checkpoint) : 300,
        onProgress: (p) => {
          const t = performance.now();
          if (t - lastPrint < 1000) return;
          lastPrint = t;
          const eta = (p.total - p.done) / Math.max(p.rate, 1);
          process.stdout.write(`\r${step.label}: ${((100 * p.done) / p.total).toFixed(1)}%  ${fmtRate(p.rate)}  eta ${fmtDuration(eta)}      `);
        },
      });
      const [stats] = await loadStats(store, step.job);
      if (!stats) throw new Error(`Rung ${step.label} did not finish.`);
      done.push({ step, store, stats });
      console.log(`\r${step.label.padEnd(5)} ${withCommas(step.count).padStart(17)} particles in ${fmtDuration(stats.seconds).padStart(8)}, ${withCommas(stats.landed)} in frame            `);
    }
  } catch (e) {
    if (/** @type {Error} */ (e).name === "AbortError") {
      console.log("Stopped. Run the same command to continue where it left off.");
      return;
    }
    throw e;
  } finally {
    device.destroy();
  }

  // Grade after every rung is rendered, so the exposure can be locked to the largest one.
  const look = lookFromArgs(args);
  const locked = args.exposure !== "auto";
  const top = done.reduce((a, b) => (b.step.count > a.step.count ? b : a), done[0]);
  const topWhite = look.white ?? exposureTrack([top.stats], { ...DEFAULT_LOOK, ...look })[0];
  /** @type {import("../core/ladder").RungResult[]} */
  const results = [];
  for (const { step, store, stats } of done) {
    const white = locked ? (topWhite * step.count) / top.step.count : undefined;
    const stillName = `${step.label}.png`;
    await gradeJob(
      store,
      nodeZlib,
      async (_f, gray, job) => root.write(stillName, await encodeGrayPng(gray, job.width, job.height, nodeZlib)),
      { look: white !== undefined ? { ...look, white } : look, label: labelFromArgs(args) },
    );
    results.push({ label: step.label, count: step.count, seconds: stats.seconds, landed: stats.landed, litPixels: stats.litPixels, still: stillName, white });
  }

  const report = ladderReport(base, frame, name, results);
  const markdown = ladderMarkdown(report);
  await root.write("ladder.json", new TextEncoder().encode(JSON.stringify(report, null, 2)));
  await root.write("ladder.md", new TextEncoder().encode(markdown));
  console.log(`\n${markdown}`);
  console.log(`Wrote the stills, ${path.join(out, "ladder.md")} and ladder.json`);
}

// ------------------------------------------------------------------ main ----

const HELP = `Strata offline runner

  bench   [--seconds 4]                          particles per second on this GPU
  render  --preset <name> [--out dir] [...]      render missing frames (resumable)
  encode  --out dir [--crf 14] [--codec hevc]    grade and encode an MP4
  still   --out dir --frame N                    grade one frame to PNG
  ladder  [--preset trillion] [--frame 0]        one frame at 1M, 100M, 10B, 1T
          [--rungs 1M,100M,10B,1T] [--out dir]   with GPU time per rung (ladder.md)
          [--exposure locked|auto]               locked: white scales with count

Presets: ${Object.keys(PRESETS).join(", ")}
Hero compositions (1T 4K stills by default): ${Object.keys(COMPOSITIONS).join(", ")}
Job overrides: --particles 1T --planes 1024 --width 3840 --height 2160 --fps 60
               --frames 600 | --seconds 10, --ssaa 1, --splat point|bilinear,
               --weighting flux|count, --seed 1, --time-scale 1, --shutter 0.5
Render: --frame N | --range a:b | --shard i/n, --checkpoint 300 (seconds),
        --batch-ms 250, --per-invocation 64, --dawn backend=vulkan
Look:   --white <particles per pixel>, --contrast 256, --gamma 1,
        --percentile 0.995, --headroom 1, --smooth 20, --label "a|b", --no-label
`;

const args = parseArgs(process.argv.slice(2));
const commands = { bench, render, encode, still, ladder };
const command = commands[args._[0]];
if (!command) {
  console.log(HELP);
  process.exit(args._[0] ? 1 : 0);
}
command(args).then(
  () => process.exit(0),
  (e) => {
    console.error(`\nError: ${e?.message ?? e}`);
    process.exit(1);
  },
);
