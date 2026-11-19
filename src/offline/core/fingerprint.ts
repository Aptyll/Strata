/**
 * Frame fingerprints, stored in every frame's stats (FrameStats.gridSha256 and
 * FrameStats.signature) so a published render can be checked frame by frame.
 * The render manifest (src/manifest) copies them, and `npm run record -- check`
 * and `verify` compare them.
 *
 * gridSha256  A SHA-256 commitment to the exact 64-bit accumulation grid.
 *             Integer adds commute, so one job gives the same hash however the
 *             frame was batched, stopped and resumed, on the same GPU model,
 *             driver and browser (or Dawn) build. Other GPUs compute sin, cos,
 *             log and pow to slightly different f32 precision, so a few
 *             particles land one pixel over and the hash differs.
 * signature   Brightness of a 16 x 9 grid of tiles, log coded. It barely moves
 *             when particles shift by a pixel, so two GPUs rendering the same
 *             frame stay close, while a different picture is far off
 *             (signatureDistance in src/manifest/manifest.mjs).
 *
 * Byte layout, so any SHA-256 tool can reproduce gridSha256:
 *
 *   gridSha256 = SHA-256( ASCII "strata-grid-v1\n<gw>x<gh>\n"
 *                         + SHA-256(low words) + SHA-256(high words) )
 *
 * The low and high words are the grid's two u32 halves, each little-endian
 * and row major, and the two inner hashes are 32 raw bytes each. <gw> and <gh>
 * are the grid's size (output size times ssaa). Hashing the halves separately
 * avoids copying a 66 MB grid into one buffer: WebCrypto has no streaming
 * digest.
 */
import { ONE } from "./job";

/** Signature tiles across and down. */
export const SIG_COLS = 16;
export const SIG_ROWS = 9;
/** Signature codes per stop (doubling of light). */
export const SIG_SCALE = 256;

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** The bytes of a typed array, as WebCrypto wants them. */
const bytesOf = (a: Uint32Array): Uint8Array<ArrayBuffer> => new Uint8Array(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength);

/**
 * SHA-256 commitment to the grid, as lowercase hex. Null where WebCrypto is
 * missing: browsers only offer it on https and localhost pages.
 */
export async function gridSha256(lo: Uint32Array, hi: Uint32Array, gridWidth: number, gridHeight: number): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  if (lo.length !== gridWidth * gridHeight || hi.length !== lo.length) throw new Error("Grid size does not match its dimensions.");
  const [low, high] = await Promise.all([subtle.digest("SHA-256", bytesOf(lo)), subtle.digest("SHA-256", bytesOf(hi))]);
  const head = new TextEncoder().encode(`strata-grid-v1\n${gridWidth}x${gridHeight}\n`);
  const all = new Uint8Array(head.length + 64);
  all.set(head, 0);
  all.set(new Uint8Array(low), head.length);
  all.set(new Uint8Array(high), head.length + 32);
  return hex(await subtle.digest("SHA-256", all));
}

/**
 * Tile brightness of the whole grid: SIG_COLS x SIG_ROWS values, row major,
 * each round(SIG_SCALE * log2(1 + light)), where light is the tile's grid
 * units divided by the units one full-weight particle adds (ONE, or more for
 * flux frames with finer weights): under count weighting, the particles in
 * the tile.
 */
export function gridSignature(lo: Uint32Array, hi: Uint32Array, gridWidth: number, gridHeight: number, unitsPerParticle: number = ONE): number[] {
  if (lo.length !== gridWidth * gridHeight || hi.length !== lo.length) throw new Error("Grid size does not match its dimensions.");
  const colOf = new Uint8Array(gridWidth);
  for (let x = 0; x < gridWidth; x++) colOf[x] = Math.floor((x * SIG_COLS) / gridWidth);
  const sums = new Float64Array(SIG_COLS * SIG_ROWS);
  for (let y = 0; y < gridHeight; y++) {
    const tileRow = Math.floor((y * SIG_ROWS) / gridHeight) * SIG_COLS;
    const at = y * gridWidth;
    for (let x = 0; x < gridWidth; x++) {
      const l = lo[at + x];
      const h = hi[at + x];
      if (l !== 0 || h !== 0) sums[tileRow + colOf[x]] += l + h * 4294967296;
    }
  }
  return Array.from(sums, (units) => Math.round(SIG_SCALE * Math.log2(1 + units / unitsPerParticle)));
}
