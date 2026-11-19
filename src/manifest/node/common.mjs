// @ts-check
/** Small helpers shared by record.mjs (plain Node) and reproduce.mjs (under tsx). */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root. */
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * A path the user typed, relative to where they ran npm (npm itself runs
 * scripts from the repository root).
 * @param {string} p
 */
export const userPath = (p) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);

/** @param {string} p a path for messages: relative to the repository when inside it */
export function shown(p) {
  const rel = path.relative(repo, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

/** `git rev-parse HEAD`, with "-dirty" when src/ has local changes. Null outside a git checkout. */
export function gitCommit() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) return null;
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "src"], { cwd: repo, encoding: "utf8" });
  return r.stdout.trim() + (dirty.stdout?.trim() ? "-dirty" : "");
}

/** Run a command and return its trimmed stdout, or null when it is missing or fails. @param {string} cmd @param {string[]} args */
export function output(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000, windowsHide: true });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** This machine, for reports. */
export function hostInfo() {
  const cpus = os.cpus();
  return {
    platform: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
    cpu: cpus[0]?.model?.trim() || "unknown",
    cores: cpus.length,
    memoryGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    node: process.version,
  };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
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

/** One line per check: PASS, FAIL or NOTE. @param {{ id: string, ok: boolean | null, detail: string }[]} checks */
export function printChecks(checks) {
  for (const c of checks) console.log(`  ${c.ok === true ? "PASS" : c.ok === false ? "FAIL" : "NOTE"}  ${c.id.padEnd(30)} ${c.detail}`);
}
