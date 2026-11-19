#!/usr/bin/env node
// @ts-check
/**
 * npm run record: write, check and reproduce render manifests.
 *
 *   npm run record -- make <dir> [--gpu "RTX 2070"] [--look look.json] [--entry "how it was launched"]
 *       Read job.json and frame-*.json (written by src/offline) in <dir> and
 *       write <dir>/manifest.json. Needs no GPU, so it runs on Noah's PC too.
 *   npm run record -- check <reference.json> <dir | manifest.json>
 *       Compare per-frame GPU counts and grid hashes. Exit 1 on any mismatch.
 *   npm run record -- render <reference.json> [--out dir] [--range a:b]
 *       Re-render frames of the manifest's job on this machine (Node + Dawn),
 *       write a manifest for them, and check it against the reference.
 *       Needs `cd src/offline && npm install` once. Not on Noah's PC (Dawn is blocked there).
 *
 * Every number comes from the frame stats the GPU wrote; see manifest.mjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest, compareManifests, sha256OfBytes } from "../manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ _: string[], [k: string]: any }} */
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (a.includes("=")) out[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

function gitCommit() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) return null;
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "src"], { cwd: repo, encoding: "utf8" });
  return r.stdout.trim() + (dirty.stdout?.trim() ? "-dirty" : "");
}

/** @param {string} file */
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/**
 * @param {string} dir
 * @param {{ gpu?: any, look?: any, entry?: string }} extra
 */
async function makeManifest(dir, extra = {}) {
  const job = await readJson(path.join(dir, "job.json"));
  const names = (await readdir(dir)).filter((n) => /^frame-\d+\.json$/.test(n)).sort();
  const stats = [];
  /** @type {Record<number, string>} */
  const imageSha256 = {};
  for (const n of names) {
    const s = await readJson(path.join(dir, n));
    stats.push(s);
    const png = path.join(dir, n.replace(/\.json$/, ".png"));
    if (existsSync(png)) imageSha256[s.frame] = await sha256OfBytes(new Uint8Array(await readFile(png)));
  }
  if (!stats.length) throw new Error(`No finished frames (frame-*.json) in ${dir}`);
  let gpu = extra.gpu ?? null;
  if (!gpu && existsSync(path.join(dir, "adapter.json"))) gpu = await readJson(path.join(dir, "adapter.json"));
  const manifest = await buildManifest({
    job,
    stats,
    imageSha256,
    commit: gitCommit(),
    renderer: "src/offline StatelessRenderer",
    entry: extra.entry ?? null,
    gpu,
    host: { platform: `${os.platform()} ${os.arch()}`, node: process.version },
    look: extra.look ?? null,
  });
  const file = path.join(dir, "manifest.json");
  await writeFile(file, JSON.stringify(manifest, null, 2));
  return { manifest, file };
}

/** @param {any} m */
function summary(m) {
  const t = m.totals;
  const last = m.frames[m.frames.length - 1];
  return [
    `${m.job.name}: ${m.particlesPerFrame} particles per frame on ${m.job.planes} sheets, ${m.job.width}x${m.job.height}`,
    `${t.framesComplete} of ${m.job.frames} frames complete; every particle evaluated in every complete frame: ${t.allEvaluated ? "yes" : "NO"}`,
    `GPU-evaluated total ${t.evaluated} in ${t.gpuSeconds.toFixed(1)} s (${(t.particlesPerSecond / 1e9).toFixed(2)} billion/s)`,
    last ? `last frame ${last.frame}: landed ${last.landed}, outside ${last.outside}` : "",
    `GPU: ${m.gpu ? Object.values(m.gpu).filter(Boolean).join(" ") : "not recorded (pass --gpu)"}; commit ${m.source.commit ?? "unknown"}`,
    "Rendered, not simulated (stateless).",
  ].filter(Boolean).join("\n");
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
function report(reference, candidate) {
  const r = compareManifests(reference, candidate);
  console.log(`Checked ${r.checked} frame(s)${r.missing.length ? `, ${r.missing.length} not in the reference` : ""}.`);
  if (r.ok) console.log("MATCH: GPU counts and grid hashes are identical.");
  else {
    console.log("MISMATCH:");
    for (const p of r.problems) console.log(`  ${p}`);
  }
  return r.ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, a, b] = args._;
  if (cmd === "make" && a) {
    const dir = path.resolve(a);
    const look = typeof args.look === "string" ? await readJson(path.resolve(args.look)) : null;
    const gpu = typeof args.gpu === "string" ? { name: args.gpu } : undefined;
    const { manifest, file } = await makeManifest(dir, { gpu, look, entry: typeof args.entry === "string" ? args.entry : undefined });
    console.log(summary(manifest));
    console.log(`Wrote ${file}`);
    return;
  }
  if (cmd === "check" && a && b) {
    process.exitCode = report(await readJson(path.resolve(a)), await loadManifestOrDir(path.resolve(b))) ? 0 : 1;
    return;
  }
  if (cmd === "render" && a) {
    const reference = await readJson(path.resolve(a));
    if (!reference.fullJob) throw new Error("This manifest has no fullJob, so it cannot be re-rendered.");
    const out = path.resolve(String(args.out ?? path.join("out", `${reference.job.name}-repro`)));
    await mkdir(out, { recursive: true });
    const jobFile = path.join(out, "job.json");
    if (!existsSync(jobFile)) await writeFile(jobFile, JSON.stringify(reference.fullJob));
    const tsx = path.join(repo, "src/offline/node_modules/tsx/dist/cli.mjs");
    if (!existsSync(tsx)) throw new Error("Run `cd src/offline && npm install` once first (tsx and webgpu live there).");
    const range = String(args.range ?? (reference.frames.length ? `${reference.frames[0].frame}:${reference.frames[0].frame + 1}` : "0:1"));
    const r = spawnSync(process.execPath, [tsx, path.join(here, "reproduce.mjs"), "--out", out, "--range", range], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`render failed (exit ${r.status})`);
    const { manifest, file } = await makeManifest(out, { entry: `npm run record -- render ${a} --range ${range}` });
    console.log(summary(manifest));
    console.log(`Wrote ${file}`);
    process.exitCode = report(reference, manifest) ? 0 : 1;
    return;
  }
  console.log(
    [
      "npm run record -- make <dir> [--gpu NAME] [--look look.json]    write <dir>/manifest.json from a finished render",
      "npm run record -- check <reference.json> <dir|manifest.json>    compare GPU counts and grid hashes",
      "npm run record -- render <reference.json> [--out dir] [--range a:b]   re-render and check (Node + Dawn)",
    ].join("\n"),
  );
  if (cmd) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
