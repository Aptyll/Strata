#!/usr/bin/env node
/**
 * `npm test`: runs every unit test in the repo. No GPU, a few seconds.
 *
 * A test is any file under src/ named *.test.js, *.test.mjs or *.test.ts.
 * Each one is bundled with esbuild (installed with Vite), so it can import the
 * TypeScript sources directly, then all bundles run under Node's built-in
 * test runner (node:test). To add tests, drop a *.test.* file next to the
 * code: it is picked up by name, nothing to register.
 *
 *   npm test               every test file
 *   npm test -- world      only files whose path contains "world"
 *
 * GPU checks are separate: `npm run verify` (shaders, needs a browser with
 * WebGPU) and src/offline/node/test.mjs (needs the "webgpu" Node package).
 */

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const files = readdirSync(join(root, "src"), { recursive: true })
  .map((f) => join("src", String(f)).split(sep).join("/"))
  .filter((f) => /\.test\.(js|mjs|ts)$/.test(f))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort();

if (files.length === 0) {
  console.error(`npm test: no test files matched${filters.length ? ` "${filters.join(" ")}"` : ""}`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "strata-test-"));
let status = 1;
try {
  // One bundle per test file, named after its path so failures say where they are.
  const bundles = await Promise.all(
    files.map(async (file) => {
      const outfile = join(dir, file.replace(/\//g, "__").replace(/\.(js|mjs|ts)$/, ".mjs"));
      await build({
        entryPoints: [join(root, file)],
        bundle: true,
        platform: "node",
        format: "esm",
        sourcemap: "inline",
        outfile,
        logLevel: "warning",
      });
      return outfile;
    }),
  );
  console.log(`npm test: ${files.length} test files\n${files.map((f) => `  ${f}`).join("\n")}\n`);
  const run = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...bundles], { stdio: "inherit" });
  status = run.status ?? 1;
} catch (e) {
  // esbuild already printed the build errors; anything else is ours to show.
  if (!(e && typeof e === "object" && "errors" in e)) console.error(e);
  console.error("npm test: could not bundle the tests");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
