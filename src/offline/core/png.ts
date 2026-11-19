/**
 * Minimal grayscale PNG codec (8 or 16 bit), enough to checkpoint frames in a
 * format any image viewer opens. Compression is injected so the same code runs
 * on Node (zlib) and in the browser (CompressionStream).
 */

export interface Zlib {
  deflate(data: Uint8Array): Promise<Uint8Array>;
  inflate(data: Uint8Array): Promise<Uint8Array>;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  const tag = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  view.setUint32(0, data.length);
  out.set(tag, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32([tag, data]));
  return out;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Encode grayscale samples. Uint16Array gives a 16-bit PNG, Uint8Array an 8-bit one. */
export async function encodeGrayPng(
  samples: Uint16Array | Uint8Array,
  width: number,
  height: number,
  zlib: Zlib,
): Promise<Uint8Array> {
  const deep = samples instanceof Uint16Array;
  const bpp = deep ? 2 : 1;
  const stride = width * bpp + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    let o = y * stride;
    raw[o++] = 0; // filter: none
    if (deep) {
      for (let x = 0; x < width; x++) {
        const v = samples[y * width + x];
        raw[o++] = v >> 8; // PNG samples are big-endian
        raw[o++] = v & 255;
      }
    } else {
      raw.set((samples as Uint8Array).subarray(y * width, (y + 1) * width), o);
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = deep ? 16 : 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlib.deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Decode a 16-bit grayscale PNG written by encodeGrayPng. */
export async function decodeGrayPng16(
  file: Uint8Array,
  zlib: Zlib,
): Promise<{ width: number; height: number; samples: Uint16Array }> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  for (let i = 0; i < 8; i++) if (file[i] !== SIGNATURE[i]) throw new Error("Not a PNG file");
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  let o = 8;
  let ended = false;
  while (o + 12 <= file.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(file[o + 4], file[o + 5], file[o + 6], file[o + 7]);
    const data = file.subarray(o + 8, o + 8 + len);
    if (o + 12 + len > file.length) break;
    if (crc32([file.subarray(o + 4, o + 8), data]) !== view.getUint32(o + 8 + len)) throw new Error("PNG checksum mismatch");
    if (type === "IHDR") {
      width = view.getUint32(o + 8);
      height = view.getUint32(o + 12);
      if (data[8] !== 16 || data[9] !== 0 || data[12] !== 0) throw new Error("Expected a 16-bit grayscale PNG");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      ended = true;
    }
    o += 12 + len;
  }
  if (!ended) throw new Error("Truncated PNG");
  const packed = new Uint8Array(idat.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const d of idat) {
    packed.set(d, p);
    p += d.length;
  }
  const raw = await zlib.inflate(packed);
  const stride = width * 2 + 1;
  if (raw.length !== stride * height) throw new Error("PNG size mismatch");
  const samples = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    let r = y * stride;
    if (raw[r++] !== 0) throw new Error("Unsupported PNG filter");
    for (let x = 0; x < width; x++, r += 2) samples[y * width + x] = (raw[r] << 8) | raw[r + 1];
  }
  return { width, height, samples };
}
