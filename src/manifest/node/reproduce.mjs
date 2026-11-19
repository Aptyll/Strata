// @ts-check
/**
 * The GPU half of `npm run record`: `verify` (and `render`, an alias),
 * `selfcheck` and `job`. record.mjs loads this file after registering tsx
 * from src/offline's install, because it imports the TypeScript renderer
 * directly. Dawn (the `webgpu` package) is loaded only when a GPU is needed,
 * so `job` also works where native dawn.node is blocked (Noah's PC).
 *
 *   verify <manifest> [--frames N | --at 0,300,590:600] [--seed S] [--out dir] [--config file]
 *          Checks the manifest on its own, runs the GPU self-checks on this
 *          machine, re-renders frames picked at random (or the frames named)
 *          with the manifest's own job, and gives each one a verdict:
 *          identical, same picture, or different. Writes the frames, a
 *          manifest of them and verify-report.json into --out.
 *   render <folder> [--range a:b]
 *          renders the missing frames of the job in a folder (resumable),
 *          after the GPU self-checks, then writes the folder's manifest
 *   selfcheck   the GPU self-checks alone
 *   job <config> [--out dir]
 *          writes the job of a record config (proof/*.json) as <dir>/job.json
 */
import { randomInt } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { totalParticles } from "../../offline/core/job";
import { StatelessRenderer } from "../../offline/core/renderer";
import { claimDirectory, frameStatsName, loadJob, renderJob } from "../../offline/core/session";
import { nodeStore, nodeZlib } from "../../offline/node/platform.mjs";
import { expandJob, validateConfig } from "../config";
import { SAME_PICTURE, buildManifest, checkManifest, compareFrame, compareManifests, gpuName, sha256OfText } from "../manifest.mjs";
import { gitCommit, hostInfo, output, printChecks, repo, shown, userPath } from "./common.mjs";
import { makeManifest, videoInfo } from "./folder.mjs";
import { selfChecks } from "./selfcheck.mjs";

const offlineDir = path.join(repo, "src/offline");
const withCommas = (/** @type {number | bigint | string} */ n) => BigInt(n).toLocaleString("en-US");

// ------------------------------------------------------------------- job ----

/** @param {string} file */
async function loadConfig(file) {
  return validateConfig(JSON.parse(await readFile(file, "utf8")));
}

/**
 * `job`: write the job a record config builds into a folder, ready for the
 * offline page (choose the folder, press render) or `verify`.
 * @param {{ _: string[], [k: string]: any }} args
 */
export async function job(args) {
  const configFile = userPath(String(args._[1] ?? path.join(repo, "proof/trillion-4k.json")));
  const config = await loadConfig(configFile);
  const j = expandJob(config);
  const out = userPath(String(args.out ?? path.join(repo, "proof/out", j.name)));
  await claimDirectory(nodeStore(out), j);
  const total = totalParticles(j);
  const evaluations = total * j.frames;
  console.log(
    [
      `${config.title}`,
      `  ${withCommas(total)} particles per frame on ${j.planes.length} sheets, seed ${config.world.seed}`,
      `  ${j.width}x${j.height}, ${j.frames} frames at ${j.fps} fps, ${j.weighting} weighting, ${j.splat} splats`,
      `  job sha256 ${await sha256OfText(JSON.stringify(j))}`,
      ...(evaluations / 6e9 > 600
        ? [
            `  ${withCommas(evaluations)} particle evaluations in all: about ${fmtDuration(evaluations / 6e9)} at 6 billion per second`,
            `  (roughly what an RTX 2070 manages with count weighting; it varies with the shot)`,
          ]
        : []),
      "",
      `Wrote ${shown(path.join(out, "job.json"))}. To render it in the browser, open /src/offline/web/,`,
      `choose that folder and press render.`,
      `Then: npm run record -- make ${shown(out)}`,
    ].join("\n"),
  );
}

// ------------------------------------------------------------------- gpu ----

/** Versions of the Node packages that render, from src/offline's install. @param {string} name */
function packageVersion(name) {
  try {
    return JSON.parse(readFileSync(path.join(offlineDir, "node_modules", name, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** Dawn instances and adapters must stay referenced while their devices live, or the process aborts. */
const keepAlive = [];

/**
 * Open a Dawn device for the job.
 * @param {string[]} flags Dawn switches, for example backend=vulkan
 * @param {import("../../offline/core/job").OfflineJob | null} job
 */
async function openDevice(flags, job) {
  const requireOffline = createRequire(path.join(offlineDir, "package.json"));
  const { create, globals } = await import(pathToFileURL(requireOffline.resolve("webgpu")).href);
  Object.assign(globalThis, globals);
  const instance = create(flags);
  keepAlive.push(instance);
  const adapter = await instance.requestAdapter({ powerPreference: "high-performance" });
  keepAlive.push(adapter);
  if (!adapter) throw new Error("No GPU adapter found. Update the graphics driver, or try --dawn backend=vulkan (d3d12 on Windows, metal on macOS).");
  const device = await adapter.requestDevice({ requiredLimits: job ? StatelessRenderer.requiredLimits(job, adapter) : {} });
  /** @type {string[]} */
  const errors = [];
  device.addEventListener("uncapturederror", (/** @type {any} */ e) => errors.push(String(e.error?.message ?? e)));
  const info = adapter.info;
  const gpu = {
    vendor: info.vendor || "",
    architecture: info.architecture || "",
    device: info.device || "",
    description: info.description || "",
    isFallbackAdapter: /** @type {any} */ (info).isFallbackAdapter ?? null,
    driver: output("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"])?.split("\n")[0] ?? null,
    dawnFlags: flags,
  };
  return { device, errors, gpu };
}

/** @param {{ [k: string]: any }} args */
const dawnFlags = (args) => (args.dawn ? String(args.dawn).split(",") : []);

/** @param {{ [k: string]: any }} args */
export async function selfcheck(args) {
  const { device, errors, gpu } = await openDevice(dawnFlags(args), null);
  try {
    console.log(`GPU self-checks on ${gpuName(gpu)}:`);
    const checks = await selfChecks(device, errors);
    printChecks(checks);
    const ok = checks.every((c) => c.ok);
    console.log(ok ? "All self-checks passed." : "A self-check FAILED: this device does not compute what the manifests rely on.");
    if (!ok) process.exitCode = 1;
  } finally {
    device.destroy();
  }
}

// ---------------------------------------------------------------- render ----

/**
 * `render <folder>`: render the missing frames of the job in a folder (made
 * by `job`, or any src/offline output folder) on this machine, then write its
 * manifest. Resumable: Ctrl+C stops after the current batch and the same
 * command continues. The GPU self-checks run first, so a device that gets the
 * basics wrong never starts a long render. A lost device (driver reset, sleep)
 * is reopened, up to 5 times in a row without a finished frame.
 * @param {{ _: string[], [k: string]: any }} args
 * @param {string} entry how this run was started, for the manifest
 * @returns {Promise<{ manifest: any, file: string } | null>} null when no frame is finished yet
 */
export async function renderFolder(args, entry) {
  const dir = userPath(String(args._[1]));
  const store = nodeStore(dir);
  const j = await loadJob(store);
  const [first, end] = typeof args.range === "string" ? args.range.split(":").map(Number) : [undefined, undefined];
  console.log(`Job "${j.name}": ${withCommas(totalParticles(j))} particles on ${j.planes.length} sheets, ${j.width}x${j.height}, ${j.frames} frames at ${j.fps} fps`);
  console.log(`Folder: ${shown(dir)}`);

  const stop = new AbortController();
  const onSigint = () => {
    if (stop.signal.aborted) process.exit(130);
    stop.abort();
    console.log("\nStopping after this batch. Progress is saved. Press Ctrl+C again to quit now.");
  };
  process.on("SIGINT", onSigint);
  const status = statusLine();
  let failures = 0;
  try {
    for (let attempt = 0; ; attempt++) {
      const { device, errors, gpu } = await openDevice(dawnFlags(args), j);
      let lost = false;
      void device.lost.then(() => (lost = true));
      try {
        if (attempt === 0) {
          console.log(`GPU: ${gpuName(gpu)}${gpu.driver ? ` (driver ${gpu.driver})` : ""}${gpu.isFallbackAdapter ? ", a software adapter" : ""}`);
          // Name the GPU next to the frames, as the offline page does, for the manifest.
          await writeFile(path.join(dir, "adapter.json"), JSON.stringify(gpu));
          console.log("GPU self-checks:");
          const self = await selfChecks(device, errors);
          printChecks(self);
          if (!self.every((c) => c.ok)) throw new Error("A GPU self-check failed, so this device would not render what the manifest claims. Not rendering.");
        }
        const r = await renderJob(device, j, store, nodeZlib, {
          first,
          end,
          kernel: args.kernel === "trillion" ? "trillion" : "offline",
          targetBatchMs: args["batch-ms"] ? Number(args["batch-ms"]) : 250,
          checkpointSeconds: args.checkpoint ? Number(args.checkpoint) : 300,
          signal: stop.signal,
          onProgress: (p) => {
            const eta = (p.total - p.done) / Math.max(p.rate, 1);
            status.show(`frame ${p.frame}: ${((100 * p.done) / p.total).toFixed(1)}%  ${fmtRate(p.rate)}  about ${fmtDuration(eta)} left in this frame`);
          },
          onFrame: (st, resumed) => {
            failures = 0;
            if (errors.length) throw new Error(`The GPU reported an error during frame ${st.frame}: ${errors[0]}`);
            status.done(`frame ${st.frame}: ${withCommas(st.evaluated)} evaluated (${st.evaluatedBy ?? "gpu"} count), ${withCommas(st.landed)} in frame, ${fmtDuration(st.seconds)}${resumed ? " (resumed)" : ""}`);
          },
        });
        console.log(`Rendered ${r.rendered} frame(s); ${r.skipped} were already done.`);
        break;
      } catch (e) {
        if (/** @type {DOMException} */ (e).name === "AbortError") {
          status.done("Stopped. Run the same command to continue where it stopped.");
          process.exitCode = 130;
          break;
        }
        const message = /** @type {Error} */ (e).message ?? String(e);
        if (!lost) await Promise.race([device.lost, new Promise((r) => setTimeout(r, 1000))]);
        if (!(lost || /device (is |was )?lost/i.test(message)) || ++failures > 5) throw e;
        console.log(`\n${message}. Reopening the GPU and resuming (attempt ${failures} of 5).`);
        await new Promise((r) => setTimeout(r, 3000));
      } finally {
        device.destroy();
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
  // Write the manifest of whatever is finished, also after a stop.
  const finished = (await readdir(dir)).some((n) => /^frame-\d+\.json$/.test(n));
  return finished ? makeManifest(dir, { entry }) : null;
}

// ---------------------------------------------------------------- verify ----

/**
 * Frames to re-render: the ones named with --at (a list, ranges a:b allowed),
 * or N picked at random from the manifest's frames (--seed makes the pick
 * repeatable). Picking after the manifest is published is what makes a
 * sample meaningful.
 * @param {number[]} available frames the manifest has
 * @param {{ [k: string]: any }} args
 */
export function pickFrames(available, args) {
  const have = new Set(available);
  if (args.at !== undefined) {
    /** @type {number[]} */
    const picks = [];
    for (const part of String(args.at).split(",").map((s) => s.trim()).filter(Boolean)) {
      const [a, b] = part.includes(":") ? part.split(":").map(Number) : [Number(part), Number(part) + 1];
      if (!Number.isInteger(a) || !Number.isInteger(b) || b <= a) throw new Error(`--at: cannot read "${part}"`);
      for (let f = a; f < b; f++) picks.push(f);
    }
    const absent = picks.filter((f) => !have.has(f));
    if (absent.length) throw new Error(`--at: frame ${absent[0]} is not in the manifest`);
    return { picks: [...new Set(picks)].sort((x, y) => x - y), how: "named with --at" };
  }
  const n = Math.min(args.frames !== undefined ? Number(args.frames) : 2, available.length);
  if (!Number.isInteger(n) || n < 0) throw new Error("--frames must be a whole number");
  const pool = [...available];
  let next;
  let how;
  if (args.seed !== undefined) {
    // mulberry32: small, well known, and the same everywhere.
    let s = Number(args.seed) >>> 0;
    next = (/** @type {number} */ max) => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
    };
    how = `${n} picked with --seed ${args.seed}`;
  } else {
    next = (/** @type {number} */ max) => randomInt(max);
    how = `${n} picked at random`;
  }
  for (let i = 0; i < n; i++) {
    const j = i + next(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { picks: pool.slice(0, n).sort((x, y) => x - y), how };
}

/** @param {string} p a manifest file, or a folder holding manifest.json */
async function loadManifest(p) {
  const file = existsSync(p) && statSync(p).isDirectory() ? path.join(p, "manifest.json") : p;
  if (!existsSync(file)) throw new Error(`No manifest at ${shown(file)}. Make one with: npm run record -- make <folder>`);
  return { file, manifest: JSON.parse(await readFile(file, "utf8")) };
}

/** @param {number} s */
function fmtDuration(s) {
  if (!Number.isFinite(s)) return "?";
  if (s < 90) return `${s.toFixed(1)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

const fmtRate = (/** @type {number} */ r) => (r >= 1e9 ? `${(r / 1e9).toFixed(2)} billion/s` : `${(r / 1e6).toFixed(1)} million/s`);

/** A status line: rewritten in place on a terminal, every 30 s in a log. */
function statusLine() {
  let last = -Infinity;
  const tty = Boolean(process.stdout.isTTY);
  return {
    /** @param {string} text */
    show(text) {
      const t = performance.now();
      if (t - last < (tty ? 1000 : 30000)) return;
      last = t;
      if (tty) process.stdout.write(`\r${text.padEnd(100)}`);
      else console.log(text);
    },
    /** @param {string} text */
    done(text) {
      if (tty) process.stdout.write(`\r${" ".repeat(100)}\r`);
      console.log(text);
      // On a terminal the next frame shows its progress at once; a log keeps one line per 30 s.
      if (tty) last = -Infinity;
    },
  };
}

/**
 * `verify`: check a published render on this machine.
 * @param {{ _: string[], [k: string]: any }} args
 * @param {string} entry how this run was started, for the re-render's manifest
 */
export async function verify(args, entry) {
  const refArg = args._[1];
  if (!refArg) throw new Error("Usage: npm run record -- verify <manifest.json | folder> [--frames N | --at list] [--seed S]");
  const { file: refFile, manifest: ref } = await loadManifest(userPath(String(refArg)));
  const out = userPath(String(args.out ?? path.join(repo, "proof/out", `verify-${ref.job?.name ?? path.basename(refFile, ".json")}`)));
  /** @type {string[]} */
  const failures = [];
  /** @type {any} */
  const report = {
    kind: "strata-verify-report",
    version: 1,
    created: new Date().toISOString(),
    reference: { file: shown(refFile), job: ref.job?.name, jobSha256: ref.job?.sha256, commit: ref.source?.commit ?? null, gpu: ref.gpu ?? null },
    checkout: { commit: gitCommit() },
    machine: { host: hostInfo(), software: { webgpu: packageVersion("webgpu"), tsx: packageVersion("tsx") } },
  };

  console.log(`Verifying ${shown(refFile)}`);
  console.log(`  ${ref.job.name}: ${withCommas(ref.particlesPerFrame)} particles per frame, ${ref.job.width}x${ref.job.height}, ${ref.frames.length} of ${ref.job.frames} frames`);
  console.log(`  rendered on ${ref.gpu ? gpuName(ref.gpu) : "an unrecorded GPU"} at commit ${ref.source?.commit ?? "unknown"}\n`);

  // 1. The file on its own.
  console.log("The manifest on its own (no GPU):");
  const checks = await checkManifest(ref);
  printChecks(checks);
  report.manifestChecks = checks;
  if (checks.some((c) => c.ok === false)) failures.push("the manifest fails its own checks");

  if (args.mp4) {
    const file = userPath(String(args.mp4));
    const got = await videoInfo(file);
    const want = ref.video?.sha256 ?? null;
    const ok = want !== null && got.sha256 === want;
    const detail = !want ? "the manifest records no video" : ok ? `${got.file} has the published SHA-256` : `${got.file} hashes to ${got.sha256.slice(0, 12)}, the manifest says ${want.slice(0, 12)}`;
    printChecks([{ id: "video file", ok, detail }]);
    report.videoCheck = { file: got.file, ok, detail };
    if (!ok) failures.push("the video file does not match the manifest");
  }

  if (args.config) {
    const config = await loadConfig(userPath(String(args.config)));
    const built = JSON.stringify(expandJob(config));
    const same = Boolean(ref.fullJob) && built === JSON.stringify(ref.fullJob);
    const detail = same
      ? `${shown(userPath(String(args.config)))} builds exactly the embedded job`
      : `${shown(userPath(String(args.config)))} builds job ${(await sha256OfText(built)).slice(0, 12)}, not the embedded ${String(ref.job.sha256).slice(0, 12)} (a different config, or the world generator changed since)`;
    printChecks([{ id: "made from the config", ok: same, detail }]);
    report.configCheck = { file: shown(userPath(String(args.config))), ok: same, detail };
    if (!same) failures.push("the config does not build the manifest's job");
  }

  const here = report.checkout.commit;
  const there = ref.source?.commit ?? null;
  if (there && here && here.replace(/-dirty$/, "") !== there.replace(/-dirty$/, "")) {
    const note = `this checkout is ${here.slice(0, 12)}, the render was made at ${there.slice(0, 12)}. Check out that commit: other commits can change particle identities or laws, and a match is then only a similar picture.`;
    printChecks([{ id: "same commit", ok: null, detail: note }]);
    report.commitNote = note;
  }

  // 2. Which frames.
  const { picks, how } = pickFrames(
    ref.frames.map((/** @type {any} */ f) => f.frame),
    args,
  );
  report.picked = picks;
  report.pickedBy = how;
  if (!ref.fullJob && picks.length) failures.push("the manifest has no embedded job to re-render");
  if (picks.length === 0 || !ref.fullJob) return finish(report, failures, null, out);
  console.log(`\nFrames to re-render (${how}): ${picks.join(", ")}`);

  // 3. This machine's GPU.
  const fullJob = ref.fullJob;
  const { device, errors, gpu } = await openDevice(dawnFlags(args), fullJob);
  report.machine.gpu = gpu;
  console.log(`\nGPU: ${gpuName(gpu)}${gpu.driver ? ` (driver ${gpu.driver})` : ""}${gpu.isFallbackAdapter ? ", a software adapter" : ""}`);

  const stop = new AbortController();
  const onSigint = () => {
    if (stop.signal.aborted) process.exit(130);
    stop.abort();
    console.log("\nStopping after this batch. Progress is saved. Press Ctrl+C again to quit now.");
  };
  process.on("SIGINT", onSigint);
  try {
    if (!args["no-selfcheck"]) {
      console.log("GPU self-checks:");
      const self = await selfChecks(device, errors);
      printChecks(self);
      report.selfChecks = self;
      if (!self.every((c) => c.ok)) {
        failures.push("a GPU self-check failed, so this device's re-render would prove nothing");
        return finish(report, failures, null, out);
      }
    }

    // 4. Re-render with the manifest's own job, through the same renderJob the record used.
    const store = nodeStore(out);
    const status = statusLine();
    const byFrame = new Map(ref.frames.map((/** @type {any} */ f) => [f.frame, f]));
    console.log(`\nRendering into ${shown(out)} (resumable: run the same command again after a stop)`);
    for (const frame of picks) {
      const errorsBefore = errors.length;
      const r = await renderJob(device, fullJob, store, nodeZlib, {
        first: frame,
        end: frame + 1,
        // The record's own kernel: the two kernels need not give the same pixels.
        kernel: byFrame.get(frame).kernel === "trillion" ? "trillion" : "offline",
        targetBatchMs: args["batch-ms"] ? Number(args["batch-ms"]) : 250,
        checkpointSeconds: 300,
        signal: stop.signal,
        onProgress: (p) => {
          const eta = (p.total - p.done) / Math.max(p.rate, 1);
          status.show(`frame ${p.frame}: ${((100 * p.done) / p.total).toFixed(1)}%  ${fmtRate(p.rate)}  about ${fmtDuration(eta)} left`);
        },
      });
      if (errors.length > errorsBefore) throw new Error(`The GPU reported an error while rendering frame ${frame}: ${errors[errorsBefore]}`);
      const statsFile = await store.read(frameStatsName(frame));
      if (!statsFile) throw new Error(`Frame ${frame} produced no stats.`);
      const stats = JSON.parse(new TextDecoder().decode(statsFile));
      const mine = (await buildManifest({ job: fullJob, stats: [stats], includeJob: false })).frames[0];
      const v = compareFrame(byFrame.get(frame), mine);
      const timing = r.rendered ? `${fmtDuration(stats.seconds)}, ${fmtRate(Number(stats.evaluated) / Math.max(stats.seconds, 1e-9))}` : "rendered in an earlier run";
      status.done(
        `frame ${frame}: ${withCommas(stats.evaluated)} evaluated (${stats.evaluatedBy ?? "gpu"} count), ${withCommas(stats.landed)} in frame, ${timing}: ${v.verdict.toUpperCase()}` +
          (v.verdict === "different" ? `\n  ${v.reasons.join("\n  ")}` : v.verdict === "same picture" ? ` (tiles ${(100 * (v.signatureDistance ?? 0)).toFixed(3)}% apart, in-frame count ${(100 * v.landedDifference).toFixed(4)}%)` : ""),
      );
    }

    // 5. A manifest of the re-rendered frames, compared with the published one.
    /** @type {any[]} */
    const stats = [];
    for (const frame of picks) stats.push(JSON.parse(new TextDecoder().decode(/** @type {Uint8Array} */ (await store.read(frameStatsName(frame))))));
    const mine = await buildManifest({
      job: fullJob,
      stats,
      commit: here,
      renderer: "src/offline StatelessRenderer",
      entry,
      gpu,
      host: { platform: report.machine.host.platform, node: process.version },
    });
    await writeFile(path.join(out, "manifest.json"), JSON.stringify(mine, null, 2));
    const cmp = compareManifests(ref, mine);
    report.comparison = cmp;
    if (!cmp.ok) failures.push(...cmp.problems);
    return finish(report, failures, cmp, out);
  } catch (e) {
    if (/** @type {DOMException} */ (e).name === "AbortError") {
      console.log(`\nStopped. To continue, run: npm run record -- verify ${refArg} --at ${picks.join(",")}${args.out ? ` --out ${args.out}` : ""}`);
      process.exitCode = 130;
      return false;
    }
    throw e;
  } finally {
    process.off("SIGINT", onSigint);
    device.destroy();
  }
}

/**
 * Print the verdict and write verify-report.json.
 * @param {any} report
 * @param {string[]} failures
 * @param {import("../manifest.d.mts").ManifestComparison | null} cmp
 * @param {string} out
 */
async function finish(report, failures, cmp, out) {
  report.ok = failures.length === 0;
  report.failures = failures;
  report.samePictureLimits = SAME_PICTURE;
  await mkdir(out, { recursive: true });
  const file = path.join(out, "verify-report.json");
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log("");
  if (cmp) {
    console.log(
      `${cmp.checked} frame(s) re-rendered: ${cmp.identical} identical, ${cmp.samePicture} same picture, ${cmp.different} different.` +
        (cmp.samePicture ? ` "Same picture" allows ${100 * SAME_PICTURE.signature}% tile brightness and ${100 * SAME_PICTURE.landed}% in-frame count: first guesses, not yet measured across GPUs.` : ""),
    );
  }
  if (report.ok) console.log(`PASS. Report: ${shown(file)}`);
  else {
    console.log("FAIL:");
    for (const f of failures) console.log(`  ${f}`);
    console.log(`Report: ${shown(file)}`);
    process.exitCode = 1;
  }
  return report.ok;
}
