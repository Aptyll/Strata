/**
 * One-off check (not part of the suite): the proof loupe's landed tally equals
 * its pixel's count in the main frame. Seconds on any adapter.
 *   npx tsx node/loupe-exact-check.mjs
 */
import { create, globals } from "webgpu";
import { StatelessRenderer } from "../core/renderer";
import { baseWorld, DEFAULT_SHOT_OPTIONS, loupeJob } from "../../proof/shots";

Object.assign(globalThis, globals);
const gpu = create([]);
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
const device = await adapter.requestDevice();
Object.assign(globalThis, { __strataDawn: [gpu, adapter, device] });
const errors = [];
device.addEventListener("uncapturederror", (e) => errors.push(e.error?.message ?? String(e)));

const main = baseWorld({ ...DEFAULT_SHOT_OPTIONS, particles: 2_000_000, width: 320, height: 180 });
const r = await StatelessRenderer.create(device, main);
const res = await r.renderFrame(0);
r.dispose();
// The 8 brightest pixels plus 8 dim lit ones.
const counts = [];
for (let i = 0; i < res.lo.length; i++) {
  const c = (res.lo[i] + res.hi[i] * 2 ** 32) / 65536;
  if (c > 0) counts.push([c, i]);
}
counts.sort((a, b) => b[0] - a[0]);
const picks = [...counts.slice(0, 8), ...counts.slice(-8)];
let bad = 0;
for (const [c, i] of picks) {
  const x = i % main.width;
  const y = Math.floor(i / main.width);
  const lr = await StatelessRenderer.create(device, loupeJob(main, x, y, 256));
  const l = await lr.renderFrame(0);
  lr.dispose();
  let sum = 0;
  for (let k = 0; k < l.lo.length; k++) sum += (l.lo[k] + l.hi[k] * 2 ** 32) / 65536;
  const ok = BigInt(c) === l.landed && sum === c;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "FAIL"} pixel (${x}, ${y}): main ${c}, loupe landed ${l.landed}, loupe grid ${sum}`);
}
console.log(errors.length ? `GPU errors: ${errors.join("; ")}` : "no GPU errors");
process.exit(bad || errors.length ? 1 : 0);
