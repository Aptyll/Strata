/**
 * RGB to Y'CbCr for the video encoder: BT.709, limited ("TV") range, 4:2:0.
 *
 * Handing the encoder RGB frames tagged as sRGB makes the browser pick the
 * conversion, and Chrome writes full-range YUV (ffprobe: yuvj420p, pc range).
 * Players and YouTube honour that flag, but many editors and converters
 * ignore it and read the file as limited range, which turns every code below
 * 16 black: exactly the faint dust and halos this project is about. Limited
 * range BT.709 is what every tool assumes, so the recorder converts itself.
 *
 * The sRGB code values are kept as they are (not re-encoded to the BT.709
 * curve) and tagged BT.709, which is the usual practice for screen captures.
 */

/** VideoFrame colorSpace for frames produced by {@link rgbaToI420}. */
export const BT709_LIMITED: VideoColorSpaceInit = {
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  fullRange: false,
};

// BT.709 luma weights in 16.16 fixed point.
const KR = 0.2126;
const KB = 0.0722;
const KG = 1 - KR - KB;
const FX = 1 << 16;
const YR = Math.round(KR * (219 / 255) * FX);
const YG = Math.round(KG * (219 / 255) * FX);
const YB = Math.round(KB * (219 / 255) * FX);
// Cb = (B - Y') / (2 (1 - KB)), Cr = (R - Y') / (2 (1 - KR)), scaled to 224 / 255.
const CB = (224 / 255) / (2 * (1 - KB));
const CR = (224 / 255) / (2 * (1 - KR));
const UR = Math.round(-KR * CB * FX);
const UG = Math.round(-KG * CB * FX);
const UB = Math.round((1 - KB) * CB * FX);
const VR = Math.round((1 - KR) * CR * FX);
const VG = Math.round(-KG * CR * FX);
const VB = Math.round(-KB * CR * FX);
const HALF = 1 << 15;

/** Bytes an I420 frame of this size needs. */
export function i420Size(width: number, height: number): number {
  return width * height + 2 * (width / 2) * (height / 2);
}

/**
 * Converts RGBA8 pixels (alpha ignored) to planar I420: the Y plane, then U,
 * then V. Width and height must be even. Chroma is taken from the average of
 * each 2 x 2 block.
 */
export function rgbaToI420(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, out: Uint8Array): void {
  const cw = width >> 1;
  const ch = height >> 1;
  const uBase = width * height;
  const vBase = uBase + cw * ch;
  for (let y = 0; y < height; y++) {
    let p = y * width * 4;
    let q = y * width;
    for (let x = 0; x < width; x++, p += 4, q++) {
      out[q] = 16 + ((YR * rgba[p] + YG * rgba[p + 1] + YB * rgba[p + 2] + HALF) >> 16);
    }
  }
  for (let cy = 0; cy < ch; cy++) {
    const row0 = cy * 2 * width * 4;
    const row1 = row0 + width * 4;
    for (let cx = 0; cx < cw; cx++) {
      const a = row0 + cx * 8;
      const b = row1 + cx * 8;
      // Sums of four samples; the fixed-point shift divides by 4 as well.
      const r = rgba[a] + rgba[a + 4] + rgba[b] + rgba[b + 4];
      const g = rgba[a + 1] + rgba[a + 5] + rgba[b + 1] + rgba[b + 5];
      const bl = rgba[a + 2] + rgba[a + 6] + rgba[b + 2] + rgba[b + 6];
      const i = cy * cw + cx;
      out[uBase + i] = 128 + ((UR * r + UG * g + UB * bl + (HALF << 2)) >> 18);
      out[vBase + i] = 128 + ((VR * r + VG * g + VB * bl + (HALF << 2)) >> 18);
    }
  }
}

/**
 * Reads any frame image back as RGBA and wraps it as an I420 VideoFrame in
 * BT.709 limited range. The caller closes the returned frame.
 */
export class I420Converter {
  private reader: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null = null;
  private buffer = new Uint8Array(0);

  convert(image: CanvasImageSource, width: number, height: number, timestampSeconds: number, durationSeconds: number): VideoFrame {
    if (!this.reader || this.reader.canvas.width !== width || this.reader.canvas.height !== height) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!ctx) throw new Error('capture: could not create a 2D context');
      this.reader = { canvas, ctx };
    }
    const { ctx } = this.reader;
    ctx.drawImage(image, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const size = i420Size(width, height);
    if (this.buffer.length !== size) this.buffer = new Uint8Array(size);
    rgbaToI420(rgba, width, height, this.buffer);
    return new VideoFrame(this.buffer, {
      format: 'I420',
      codedWidth: width,
      codedHeight: height,
      timestamp: Math.round(timestampSeconds * 1e6),
      duration: Math.round(durationSeconds * 1e6),
      colorSpace: BT709_LIMITED,
    });
  }
}
