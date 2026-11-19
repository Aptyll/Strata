#!/usr/bin/env node
/**
 * Headless runner for the verify page: `npm run verify`.
 *
 * Serves the repo with Vite, opens src/verify/index.html in Chromium with
 * WebGPU enabled, waits for the report and exits non-zero if any case failed.
 *
 *   npm run verify                    all cases, software GPU (SwiftShader)
 *   npm run verify -- behaviors       only cases whose file or name contains "behaviors"
 *   npm run verify -- --hardware      use the machine's real GPU (opens a window)
 *
 * Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).
 * Without it, run `npm run dev` and open /src/verify/ in any WebGPU browser.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const hardware = args.includes("--hardware");
const filter = args.find((a) => !a.startsWith("--")) ?? "";
const timeoutMs = Number(process.env.VERIFY_TIMEOUT_MS ?? 300_000);

// createRequire resolves like CommonJS, which also finds a global install through NODE_PATH.
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error(
    "verify: Playwright is not installed.\n" +
      "  Either: npm i -D playwright && npx playwright install chromium\n" +
      "  Or:     npm run dev, then open /src/verify/ in a WebGPU browser.",
  );
  process.exit(2);
}

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 5199 } });
await server.listen();
const base = server.resolvedUrls?.local[0] ?? "http://127.0.0.1:5199/";
const url = `${base}src/verify/index.html${filter ? `?filter=${encodeURIComponent(filter)}` : ""}`;

const browser = await chromium.launch({
  headless: !hardware,
  args: hardware
    ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan"]
    : ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader"],
});

let exitCode = 1;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`console: ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__verify?.done === true, undefined, { timeout: timeoutMs });
  const report = await page.evaluate(() => window.__verify);
  console.log(await page.evaluate(() => document.querySelector("pre")?.textContent ?? ""));
  if (report.results.length === 0) console.error("verify: no cases matched");
  exitCode = report.failed === 0 && report.results.length > 0 ? 0 : 1;
} catch (e) {
  console.error(`verify: ${e instanceof Error ? e.message : e}`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(exitCode);
