#!/usr/bin/env node
// @ts-check
/**
 * npm run record: make, check and verify render manifests. Walkthrough:
 * docs/proof/reproduce.md.
 *
 *   npm run record -- job [config.json] [--out dir]
 *       Write the job of a record config (default proof/trillion-4k.json) as
 *       <dir>/job.json. Choose that folder in /src/offline/web/ and press
 *       render to render exactly that job. Needs tsx (npm ci --prefix src/offline), no GPU.
 *   npm run record -- make <dir> [--gpu "RTX 2070"] [--look look.json] [--entry "how it was launched"] [--mp4 file]
 *       Read job.json and frame-*.json (written by src/offline) in <dir> and
 *       write <dir>/manifest.json, with the video's SHA-256 when there is one.
 *       Needs no GPU, so it runs on Noah's PC too.
 *   npm run record -- check <reference.json> <dir | manifest.json>
 *       Compare frames frame by frame: identical, same picture or different.
 *       Exit 1 on any different frame. No GPU.
 *   npm run record -- verify <reference.json | dir> [--frames N | --at 0,300] [--seed S] [--out dir] [--config file] [--mp4 file]
 *       Check the manifest on its own, run the GPU self-checks, re-render
 *       frames picked at random on this machine (Node + Dawn) and compare.
 *       `render <reference.json> --range a:b` is the same with the frames named.
 *   npm run record -- render <folder> [--range a:b]
 *       Render the missing frames of the job in a folder on this machine
 *       (Node + Dawn, resumable), after the GPU self-checks, then make its manifest.
 *   npm run record -- selfcheck
 *       The GPU self-checks alone.
 *
 * verify, render and selfcheck need Dawn: `npm ci --prefix src/offline` once,
 * on any machine but Noah's PC (Windows Application Control blocks dawn.node).
 * Every number comes from the frame stats the GPU wrote; see manifest.mjs.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkManifest, compareManifests, gpuName } from "../manifest.mjs";
import { parseArgs, printChecks, repo, shown, userPath } from "./common.mjs";
import { makeManifest, readJson } from "./folder.mjs";

/** @param {any} m */
function summary(m) {
  const t = m.totals;
  const last = m.frames[m.frames.length - 1];
  const hashed = m.frames.filter((/** @type {any} */ f) => f.gridSha256 && f.signature).length;
  return [
    `${m.job.name}: ${m.particlesPerFrame} particles per frame on ${m.job.planes} sheets, ${m.job.width}x${m.job.height}`,
    `${t.framesComplete} of ${m.job.frames} frames complete; every particle evaluated in every complete frame: ${t.allEvaluated ? "yes" : "NO"}`,
    `Evaluated total ${t.evaluated} in ${t.gpuSeconds.toFixed(1)} s (${(t.particlesPerSecond / 1e9).toFixed(2)} billion/s), ` +
      (t.countedOnGpu === true ? "counted on the GPU" : t.countedOnGpu === false ? "NOT all counted on the GPU (some frames summed dispatch sizes)" : "counter not recorded"),
    `Weighting: ${m.drawing?.meaning ?? "unknown"}${t.eachLandedAddedOnce === true ? " (verified: grid sum = landed x 65536 in every frame)" : t.eachLandedAddedOnce === false ? " (FAILED: grid sum != landed x 65536)" : ""}`,
    last ? `last frame ${last.frame}: landed ${last.landed}, outside ${last.outside}` : "",
    `Fingerprints (exact grid hash and tile signature): ${hashed} of ${m.frames.length} frames`,
    m.video ? `Video: ${m.video.file}, ${m.video.bytes} bytes, sha256 ${m.video.sha256}` : "Video: none (pass --mp4 <file>, or put <job name>.mp4 in the folder)",
    `GPU: ${m.gpu ? gpuName(m.gpu) : "not recorded (pass --gpu)"}; commit ${m.source.commit ?? "unknown"}`,
    "Rendered, not simulated (stateless).",
  ]
    .filter(Boolean)
    .join("\n");
}

/** @param {string} p */
async function loadManifestOrDir(p) {
  if (statSync(p).isDirectory()) {
    const f = path.join(p, "manifest.json");
    return existsSync(f) ? readJson(f) : (await makeManifest(p)).manifest;
  }
  return readJson(p);
}

/** @param {any} reference @param {any} candidate */
async function report(reference, candidate) {
  // A published file must also hold together on its own (for example grid sum = landed x 65536).
  const failed = (await checkManifest(reference)).filter((c) => c.ok === false);
  if (failed.length) {
    console.log("The reference fails its own checks:");
    printChecks(failed);
  }
  const r = compareManifests(reference, candidate);
  console.log(`Checked ${r.checked} frame(s)${r.missing.length ? `, ${r.missing.length} not in the reference` : ""}: ${r.identical} identical, ${r.samePicture} same picture, ${r.different} different.`);
  for (const f of r.frames) if (f.verdict === "same picture") console.log(`  frame ${f.frame}: same picture (tiles ${(100 * (f.signatureDistance ?? 0)).toFixed(3)}% apart, in-frame count ${(100 * f.landedDifference).toFixed(4)}%)`);
  if (r.ok && !failed.length) console.log(r.samePicture ? "MATCH: same GPU counts; pictures within the same-picture limits." : "MATCH: identical frames.");
  else {
    console.log("MISMATCH:");
    for (const p of [...failed.map((c) => `reference: ${c.id}: ${c.detail}`), ...r.problems]) console.log(`  ${p}`);
  }
  return r.ok && !failed.length;
}

/**
 * The GPU half (reproduce.mjs) imports the TypeScript renderer, so it runs
 * through tsx from src/offline's install, registered in this process (no
 * child process, so Ctrl+C reaches the render exactly once).
 * @param {boolean} needsDawn
 * @returns {Promise<typeof import("./reproduce.mjs")>}
 */
async function gpuHalf(needsDawn) {
  const modules = path.join(repo, "src/offline/node_modules");
  const missing = ["tsx", ...(needsDawn ? ["webgpu"] : [])].filter((n) => !existsSync(path.join(modules, n, "package.json")));
  if (missing.length) {
    throw new Error(
      [
        `This step needs ${missing.join(" and ")} from src/offline, installed once at the versions pinned in src/offline/package-lock.json:`,
        "",
        "  npm ci --prefix src/offline",
        ...(needsDawn ? ["", "It renders with Dawn (native dawn.node), which Noah's PC blocks: run it on another machine."] : []),
      ].join("\n"),
    );
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 6)) throw new Error(`This step needs Node 20.6 or newer (22 recommended). This is ${process.version}.`);
  const tsxPkg = JSON.parse(readFileSync(path.join(modules, "tsx", "package.json"), "utf8"));
  const api = tsxPkg.exports?.["./esm/api"]?.import?.default ?? "./dist/esm/api/index.mjs";
  const { register } = await import(pathToFileURL(path.join(modules, "tsx", api)).href);
  register();
  return import("./reproduce.mjs");
}

const HELP = [
  "npm run record -- job [config.json] [--out dir]                 write a record config's job.json, to render in /src/offline/web/",
  "npm run record -- make <dir> [--gpu NAME] [--look look.json] [--mp4 file]   write <dir>/manifest.json from a finished render",
  "npm run record -- check <reference.json> <dir|manifest.json>    compare frames: identical, same picture or different",
  "npm run record -- verify <reference.json|dir> [--frames N | --at 0,300] [--seed S]   re-render frames here and compare (Node + Dawn)",
  "npm run record -- render <folder> [--range a:b]                 render a job folder's missing frames here (Node + Dawn), then make its manifest",
  "npm run record -- render <reference.json> [--range a:b]         the same as verify with the frames named",
  "npm run record -- selfcheck                                     GPU self-checks on this machine (Node + Dawn)",
  "Walkthrough: docs/proof/reproduce.md",
].join("\n");

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const [cmd, a, b] = args._;
  if (cmd === "make" && a) {
    const dir = userPath(a);
    const look = typeof args.look === "string" ? await readJson(userPath(args.look)) : null;
    const gpu = typeof args.gpu === "string" ? { name: args.gpu } : undefined;
    const mp4 = typeof args.mp4 === "string" ? userPath(args.mp4) : undefined;
    const { manifest, file } = await makeManifest(dir, { gpu, look, entry: typeof args.entry === "string" ? args.entry : undefined, mp4 });
    console.log(summary(manifest));
    console.log(`Wrote ${shown(file)}`);
    return;
  }
  if (cmd === "check" && a && b) {
    process.exitCode = (await report(await readJson(userPath(a)), await loadManifestOrDir(userPath(b)))) ? 0 : 1;
    return;
  }
  if (cmd === "job") return (await gpuHalf(false)).job(args);
  if (cmd === "selfcheck") return (await gpuHalf(true)).selfcheck(args);
  if (cmd === "render" && a && existsSync(path.join(userPath(a), "job.json"))) {
    // A folder with a job: render its missing frames here, then write its manifest.
    const made = await (await gpuHalf(true)).renderFolder(args, `npm run record -- ${argv.join(" ")}`);
    if (made) {
      console.log(summary(made.manifest));
      console.log(`Wrote ${shown(made.file)}`);
    }
    return;
  }
  if ((cmd === "verify" || cmd === "render") && a) {
    // render --range a:b (the original command) is verify with those frames, end exclusive.
    if (cmd === "render" && args.at === undefined) args.at = typeof args.range === "string" ? args.range : undefined;
    if (cmd === "render" && args.at === undefined) args.frames = 1;
    await (await gpuHalf(true)).verify(args, `npm run record -- ${argv.join(" ")}`);
    return;
  }
  console.log(HELP);
  if (cmd) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
