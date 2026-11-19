// @ts-check
/**
 * GPU half of `npm run record -- render`: renders the frames of the job.json
 * already in --out with src/offline's renderJob on Dawn, and writes the GPU
 * adapter name to adapter.json. Run by record.mjs through src/offline's tsx
 * (it needs TypeScript imports and the `webgpu` package installed there).
 *
 *   tsx reproduce.mjs --out <dir> [--range a:b]
 *
 * Noah's PC blocks native dawn.node (Windows Application Control), so this
 * runs on other machines only; there, render in /src/offline/web/ and use
 * `npm run record -- make` and `check`, which need no GPU.
 */
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { StatelessRenderer } from "../../offline/core/renderer";
import { loadJob, renderJob } from "../../offline/core/session";
import { nodeStore, nodeZlib } from "../../offline/node/platform.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = path.resolve(opt("out") ?? ".");
const range = opt("range");

// `webgpu` lives in src/offline/node_modules, not beside this file.
const requireFromOffline = createRequire(new URL("../../offline/package.json", import.meta.url));
const { create, globals } = await import(pathToFileURL(requireFromOffline.resolve("webgpu")).href);
Object.assign(globalThis, globals);

const store = nodeStore(out);
const job = await loadJob(store);
// Keep the instance and adapter referenced while the device lives, or Dawn aborts.
const gpu = create([]);
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
if (!adapter) throw new Error("No GPU adapter found.");
const info = adapter.info;
const gpuInfo = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
await writeFile(path.join(out, "adapter.json"), JSON.stringify(gpuInfo));
console.log(`Adapter: ${Object.values(gpuInfo).filter(Boolean).join(" ") || "unknown"}`);

const device = await adapter.requestDevice({ requiredLimits: StatelessRenderer.requiredLimits(job, adapter) });
const [first, end] = range?.includes(":") ? range.split(":").map(Number) : [undefined, undefined];
try {
  const r = await renderJob(device, job, store, nodeZlib, {
    first,
    end,
    checkpointSeconds: 300,
    onFrame: (s) => console.log(`frame ${s.frame}: evaluated ${s.evaluated}, landed ${s.landed}, ${s.seconds.toFixed(1)} s`),
  });
  console.log(`Rendered ${r.rendered} frames, ${r.skipped} already done.`);
} finally {
  device.destroy();
  void gpu;
}
