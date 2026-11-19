#!/usr/bin/env node
/**
 * `npm run smoke`: opens every page of the built site in headless Chromium on
 * a software GPU and fails if a page throws, logs an error, raises a WebGPU
 * error, loses its GPU device or stops drawing frames.
 *
 * It answers one question: does what we are about to deploy still start?
 * tsc, the build and the unit tests cannot see a crash during boot, a pass
 * wired up wrong or a bind group that does not match its shader.
 *
 *   npm run build && npm run smoke     every page
 *   npm run smoke -- challenge         only pages whose URL contains "challenge"
 *
 * Pages come from two places. PAGES below lists the known ones with a URL
 * that keeps them light (a software GPU hangs at about a million particles)
 * and how many frames they must draw. Every other .html file in dist/ is
 * opened with no options and only has to load without an error, so a new
 * page is covered from its first build.
 *
 * A page that fails is opened once more and only counts as failed if it fails
 * twice, so one hiccup of the software GPU does not turn the check red.
 *
 * Needs `npm run build` first and Playwright with Chromium, like
 * `npm run verify`. It proves the site starts, never how fast it runs.
 */

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));

/**
 * Known pages. `frames` is how many GPU submits the page must make before it
 * passes (0: it only has to load). Keep particle counts near 20k here.
 */
const PAGES = [
  { url: "/?particles=20000&planes=6&intro=0", frames: 30, what: "the world, fixed layout" },
  { url: "/?particles=20000&planes=6", frames: 30, what: "the world with the opening" },
  { url: "/?particles=20000&world=strata", frames: 30, what: "the streamed endless world" },
  { url: "/?challenge&count=20000&planes=4&res=320x180", frames: 30, what: "Challenge mode from the app" },
  { url: "/src/challenge/?count=20000&planes=4&res=320x180", frames: 30, what: "Challenge mode page" },
  { url: "/src/perf/bench/?n=20k&planes=4&res=320x180", frames: 30, what: "bench page" },
  { url: "/src/offline/web/", frames: 0, what: "offline renderer page" },
  { url: "/src/proof/web/", frames: 0, what: "proof shots page" },
];

/** How long a page gets to reach its frame count, and how long a load-only page is watched. */
const FRAME_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
const SETTLE_MS = 2_000;

if (!existsSync(join(dist, "index.html"))) {
  console.error("smoke: dist/ is missing. Run `npm run build` first.");
  process.exit(2);
}

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("smoke: Playwright is not installed.\n  npm i --no-save playwright && npx playwright install chromium");
  process.exit(2);
}

// Every built page that PAGES does not already name, opened with no options.
const known = new Set(PAGES.map((p) => p.url.split("?")[0]));
const built = readdirSync(dist, { recursive: true })
  .map((f) => String(f).split(sep).join("/"))
  .filter((f) => f.endsWith(".html"))
  .map((f) => "/" + f.replace(/index\.html$/, ""))
  .filter((url) => !known.has(url))
  .sort()
  .map((url) => ({ url, frames: 0, what: "built page (load only)" }));

const pages = [...PAGES, ...built].filter((p) => filters.length === 0 || filters.some((x) => p.url.includes(x)));
if (pages.length === 0) {
  console.error(`smoke: no page matched "${filters.join(" ")}"`);
  process.exit(1);
}

/**
 * Runs in the page before any of its scripts. Counts devices and submits,
 * records WebGPU errors and device loss, and stands in for canvas presentation.
 */
function instrument() {
  const report = { devices: 0, submits: 0, errors: [] };
  Object.defineProperty(window, "__smoke", { value: report });
  if (!navigator.gpu) return;

  // A page may destroy its own device (the verify page does, case by case).
  // Any other loss is the failure this check exists to catch.
  const destroyedOnPurpose = new WeakSet();
  const destroy = GPUDevice.prototype.destroy;
  GPUDevice.prototype.destroy = function () {
    destroyedOnPurpose.add(this);
    return destroy.call(this);
  };
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const device = await requestDevice.apply(this, args);
    report.devices++;
    device.addEventListener("uncapturederror", (e) => report.errors.push(`WebGPU error: ${e.error.message}`));
    device.lost.then((info) => {
      if (!destroyedOnPurpose.has(device)) report.errors.push(`WebGPU device lost: ${info.message}`);
    });
    return device;
  };

  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (...args) {
    report.submits++;
    return submit.apply(this, args);
  };

  // A headless browser cannot present a WebGPU canvas: configuring one loses
  // the device. Hand the page an ordinary texture of the canvas size instead.
  const configured = new WeakMap();
  const proto = GPUCanvasContext.prototype;
  proto.configure = function (config) {
    configured.get(this)?.texture?.destroy();
    configured.set(this, { config, texture: null, width: 0, height: 0 });
  };
  proto.unconfigure = function () {
    configured.get(this)?.texture?.destroy();
    configured.delete(this);
  };
  proto.getCurrentTexture = function () {
    const state = configured.get(this);
    if (!state) throw new DOMException("The canvas context is not configured", "InvalidStateError");
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    if (!state.texture || state.width !== width || state.height !== height) {
      state.texture?.destroy();
      state.texture = state.config.device.createTexture({
        label: "smoke: stand-in for the canvas",
        size: [width, height],
        format: state.config.format,
        usage: (state.config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC,
        viewFormats: state.config.viewFormats ?? [],
      });
      state.width = width;
      state.height = height;
    }
    return state.texture;
  };
}

const server = await preview({ root, logLevel: "error", preview: { host: "127.0.0.1", port: 5198 } });
const base = (server.resolvedUrls?.local[0] ?? "http://127.0.0.1:5198/").replace(/\/$/, "");
const args = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader"];

/** Open one page in its own browser, so a page that stalls the GPU cannot fail the next one. */
async function open(page) {
  const problems = [];
  const browser = await chromium.launch({ headless: true, args });
  let report = { devices: 0, submits: 0, errors: [] };
  try {
    const tab = await browser.newPage({ viewport: { width: 640, height: 360 } });
    await tab.addInitScript(instrument);
    tab.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
    tab.on("console", (m) => {
      if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
    });
    tab.on("requestfailed", (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
    tab.on("response", (r) => {
      if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
    });
    const read = () => tab.evaluate(() => ({ ...window.__smoke }));
    await tab.goto(base + page.url, { waitUntil: "load", timeout: FRAME_TIMEOUT_MS });
    // Wait for the frames, but stop at the first sign of trouble.
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (page.frames > 0 && Date.now() < deadline) {
      report = await read();
      if (report.submits >= page.frames || report.errors.length > 0 || problems.length > 0) break;
      await tab.waitForTimeout(100);
    }
    // Let late errors arrive (a lost device, a validation error on the next frame).
    await tab.waitForTimeout(SETTLE_MS);
    report = await read();
    problems.push(...report.errors);
    if (page.frames > 0 && report.devices === 0) problems.push("no WebGPU device was created (did the page fall back?)");
    if (page.frames > 0 && report.submits < page.frames) problems.push(`drew ${report.submits} of ${page.frames} frames`);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  } finally {
    await browser.close();
  }
  // GPU messages run to many lines and repeat every frame: keep each one's first line, once.
  const lines = [...new Set(problems.map((p) => p.split("\n")[0].slice(0, 300)))];
  return { lines, report };
}

async function check(page) {
  const started = Date.now();
  let { lines, report } = await open(page);
  let note = "";
  if (lines.length > 0) {
    const first = lines;
    ({ lines, report } = await open(page));
    if (lines.length === 0) {
      note = "  passed on the second try; the first try said:";
      lines = first;
    }
  }
  const failed = lines.length > 0 && note === "";
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${failed ? "FAIL" : "ok  "}  ${page.url}  (${page.what}: ${report.devices} device, ${report.submits} submits, ${seconds} s)${note}`);
  for (const line of lines.slice(0, 6)) console.log(`        ${line}`);
  if (lines.length > 6) console.log(`        ... and ${lines.length - 6} more`);
  return !failed;
}

let failed = 0;
try {
  for (const page of pages) if (!(await check(page))) failed++;
} finally {
  await server.close();
}
console.log(`\nsmoke: ${pages.length - failed} of ${pages.length} pages start cleanly`);
process.exit(failed === 0 ? 0 : 1);
