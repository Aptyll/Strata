// Run with: npm test -- fingerprint
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SIG_COLS, SIG_ROWS, SIG_SCALE, gridSha256, gridSignature } from "./fingerprint.ts";
import { ONE } from "./job.ts";

const sha = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

test("gridSha256 follows the documented layout", async () => {
  const w = 5;
  const h = 3;
  const lo = Uint32Array.from({ length: w * h }, (_, i) => (i * 2654435761) >>> 0);
  const hi = Uint32Array.from({ length: w * h }, (_, i) => i % 3);
  const bytes = (a) => {
    const out = new Uint8Array(a.length * 4);
    const view = new DataView(out.buffer);
    a.forEach((v, i) => view.setUint32(i * 4, v, true)); // little-endian words
    return out;
  };
  const expected = sha(new TextEncoder().encode(`strata-grid-v1\n${w}x${h}\n`), sha(bytes(lo)), sha(bytes(hi))).toString("hex");
  assert.equal(await gridSha256(lo, hi, w, h), expected);
});

test("gridSha256 changes when any one unit moves", async () => {
  const lo = new Uint32Array(16 * 9).fill(7);
  const hi = new Uint32Array(16 * 9);
  const a = await gridSha256(lo, hi, 16, 9);
  lo[3]--;
  lo[4]++;
  assert.notEqual(await gridSha256(lo, hi, 16, 9), a);
});

test("gridSignature puts each cell's light in its tile, log coded", () => {
  const w = SIG_COLS * 4;
  const h = SIG_ROWS * 2;
  const lo = new Uint32Array(w * h);
  const hi = new Uint32Array(w * h);
  // One particle (ONE units) in the top-left cell, three in the bottom-right cell.
  lo[0] = ONE;
  lo[w * h - 1] = 3 * ONE;
  // 2^32 units in a middle cell, held in the high word: 65536 particles.
  const mid = (h / 2) * w + w / 2;
  hi[mid] = 1;
  const sig = gridSignature(lo, hi, w, h);
  assert.equal(sig.length, SIG_COLS * SIG_ROWS);
  assert.equal(sig[0], Math.round(SIG_SCALE * Math.log2(2)));
  assert.equal(sig[SIG_COLS * SIG_ROWS - 1], Math.round(SIG_SCALE * Math.log2(4)));
  const midTile = Math.floor((h / 2) * SIG_ROWS / h) * SIG_COLS + Math.floor((w / 2) * SIG_COLS / w);
  assert.equal(sig[midTile], Math.round(SIG_SCALE * Math.log2(1 + 2 ** 32 / ONE)));
  assert.equal(sig.filter((v) => v !== 0).length, 3);
});
