/** Shared helpers for the capture module. */

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Chrome limits: 32767 px per side and 2^28 px total area for 2D canvases. */
export const MAX_CANVAS_SIDE = 32767;
export const MAX_CANVAS_AREA = 268_435_456;

export function timestampName(prefix: string, ext: string, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${prefix}-${stamp}.${ext}`;
}

/** Triggers a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before the URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 2D canvases this module created, which are safe to read back directly. */
const own2d = new WeakMap<OffscreenCanvas, OffscreenCanvasRenderingContext2D>();

function make2d(width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('capture: could not create a 2D context');
  own2d.set(canvas, ctx);
  return { canvas, ctx };
}

/**
 * Copies and (optionally) downscales a canvas into a 2D canvas.
 *
 * The copy of the source happens synchronously in `draw`, which matters for
 * WebGPU and WebGL canvases: their contents are only readable in the same task
 * that rendered them.
 *
 * Downscaling by a whole factor (supersampling) is a box filter computed in
 * linear light: every k x k block of source pixels is decoded from sRGB,
 * averaged, and encoded again. Averaging the sRGB codes directly, which is
 * what `drawImage` does, darkens sparse particles and edges: one white
 * subpixel among three black ones should come out at code 137, not 64.
 *
 * Other ratios fall back to `drawImage`, in successive halvings when the
 * ratio is above 4. A single bilinear `drawImage` only reads 4 source texels
 * per output pixel and would skip most particles; halving makes every source
 * pixel contribute.
 */
export class Resampler {
  readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private steps: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    /** CSS colour painted under each frame, or null to keep transparency. */
    private readonly background: string | null = '#000',
  ) {
    const out = make2d(width, height);
    this.canvas = out.canvas;
    this.ctx = out.ctx;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  /** Set false to average sRGB codes like `drawImage` does (faster, darker). */
  linear = true;
  private scratch: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null = null;
  private backgroundRgb: [number, number, number] | null = null;

  draw(source: CanvasImageSource, sourceWidth?: number, sourceHeight?: number): void {
    let src: CanvasImageSource = source;
    let sw = sourceWidth ?? (source as ImageBitmap).width;
    let sh = sourceHeight ?? (source as ImageBitmap).height;
    const k = sw / this.width;
    if (this.linear && k >= 2 && Number.isInteger(k) && sh === this.height * k) {
      this.drawLinear(source, sw, sh, k);
      return;
    }
    let i = 0;
    while (sw >= this.width * 4 && sh >= this.height * 4) {
      const w = Math.ceil(sw / 2);
      const h = Math.ceil(sh / 2);
      let step = this.steps[i];
      if (!step || step.canvas.width !== w || step.canvas.height !== h) {
        step = make2d(w, h);
        step.ctx.imageSmoothingEnabled = true;
        step.ctx.imageSmoothingQuality = 'high';
        this.steps[i] = step;
      }
      step.ctx.clearRect(0, 0, w, h);
      step.ctx.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
      src = step.canvas;
      sw = w;
      sh = h;
      i++;
    }
    if (this.background) {
      this.ctx.fillStyle = this.background;
      this.ctx.fillRect(0, 0, this.width, this.height);
    } else {
      this.ctx.clearRect(0, 0, this.width, this.height);
    }
    this.ctx.drawImage(src, 0, 0, sw, sh, 0, 0, this.width, this.height);
  }

  private drawLinear(source: CanvasImageSource, sw: number, sh: number, k: number): void {
    // Read the source pixels. Our own 2D canvases (tile stitching) are read
    // directly; anything else (a WebGPU canvas, a VideoFrame) is first copied,
    // synchronously, into a scratch 2D canvas. Calling getContext('2d') on
    // someone else's canvas could create a context on it, so we never do.
    let read: OffscreenCanvasRenderingContext2D | undefined =
      source instanceof OffscreenCanvas ? own2d.get(source) : undefined;
    if (!read) {
      if (!this.scratch || this.scratch.canvas.width !== sw || this.scratch.canvas.height !== sh) {
        const canvas = new OffscreenCanvas(sw, sh);
        const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
        if (!ctx) throw new Error('capture: could not create a 2D context');
        this.scratch = { canvas, ctx };
      }
      this.scratch.ctx.clearRect(0, 0, sw, sh);
      this.scratch.ctx.drawImage(source, 0, 0, sw, sh);
      read = this.scratch.ctx;
    }
    const bg = this.background ? (this.backgroundRgb ??= parseColor(this.background)) : null;
    // Work in horizontal strips to bound memory on very large stills.
    const rowsPerStrip = Math.max(1, Math.floor(16_777_216 / (sw * k)));
    for (let y = 0; y < this.height; y += rowsPerStrip) {
      const rows = Math.min(rowsPerStrip, this.height - y);
      const input = read.getImageData(0, y * k, sw, rows * k);
      const output = this.ctx.createImageData(this.width, rows);
      boxFilterLinear(input.data, sw, rows * k, k, output.data, bg);
      this.ctx.putImageData(output, 0, y);
    }
  }

  /** Draws a source into a sub-rectangle without clearing (used for tile stitching). */
  blit(source: CanvasImageSource, x: number, y: number, w: number, h: number): void {
    this.ctx.drawImage(source, 0, 0, w, h, x, y, w, h);
  }

  fill(color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  toBlob(type = 'image/png', quality?: number): Promise<Blob> {
    return this.canvas.convertToBlob({ type, quality });
  }
}

/**
 * The CSS filter on a canvas element, or null when it has none. The app's
 * color themes (src/ux/theme) are such a filter: the browser applies it when
 * it shows the canvas, but it is not in the canvas pixels, so captures have to
 * bake it in to save what is on screen.
 */
export function cssFilterOf(source: unknown): string | null {
  if (typeof HTMLCanvasElement === 'undefined' || !(source instanceof HTMLCanvasElement)) return null;
  const filter = getComputedStyle(source).filter;
  return filter && filter !== 'none' ? filter : null;
}

/**
 * Bakes a CSS filter into an image by drawing it into a 2D canvas element with
 * `ctx.filter` set. It has to be an element: OffscreenCanvas accepts url()
 * filters, which is what the themes use, and then ignores them. Use it on the
 * final, already downsampled image, so a theme does not change how light is
 * averaged.
 */
export class FilterStage {
  readonly canvas: HTMLCanvasElement = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;

  constructor() {
    const ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('capture: could not create a 2D context');
    this.ctx = ctx;
  }

  /** Draws `source` at `width` x `height` through `filter` and returns the canvas holding the result. */
  draw(source: CanvasImageSource, width: number, height: number, filter: string): HTMLCanvasElement {
    setCanvasSize(this.canvas, width, height);
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.filter = filter;
    this.ctx.drawImage(source, 0, 0, width, height);
    this.ctx.filter = 'none';
    return this.canvas;
  }

  toBlob(type = 'image/png', quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) =>
      this.canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('capture: could not encode the image'))),
        type,
        quality,
      ),
    );
  }
}

// sRGB transfer function, as lookup tables: 8 bit code to linear, and linear
// (in 1/4096 steps, ample for an 8 bit result) back to code.
const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LINEAR_STEPS = 4096;
const TO_SRGB = new Uint8Array(LINEAR_STEPS + 1);
for (let i = 0; i <= LINEAR_STEPS; i++) {
  const l = i / LINEAR_STEPS;
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  TO_SRGB[i] = Math.round(c * 255);
}
const encode = (linear: number) => TO_SRGB[Math.round(Math.min(1, Math.max(0, linear)) * LINEAR_STEPS)];

/**
 * Downscales RGBA8 pixels (unpremultiplied sRGB, as getImageData returns
 * them) by a whole factor `k`, averaging each k x k block in linear light.
 * With a background colour the result is opaque, composited over it;
 * without one, alpha is averaged and colour is weighted by alpha.
 * `src` is `sw` x `sh`; `out` is (sw / k) x (sh / k). Exported for testing.
 */
export function boxFilterLinear(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  k: number,
  out: Uint8ClampedArray,
  background: [number, number, number] | null,
): void {
  const ow = Math.floor(sw / k);
  const oh = Math.floor(sh / k);
  const n = k * k;
  const bg = background && background.map((c) => TO_LINEAR[c]);
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < k; dy++) {
        let p = ((oy * k + dy) * sw + ox * k) * 4;
        for (let dx = 0; dx < k; dx++, p += 4) {
          const alpha = src[p + 3] / 255;
          r += TO_LINEAR[src[p]] * alpha;
          g += TO_LINEAR[src[p + 1]] * alpha;
          b += TO_LINEAR[src[p + 2]] * alpha;
          a += alpha;
        }
      }
      const q = (oy * ow + ox) * 4;
      if (bg) {
        // Premultiplied colour over the background: c + bg * (1 - alpha).
        const rest = 1 - a / n;
        out[q] = encode(r / n + bg[0] * rest);
        out[q + 1] = encode(g / n + bg[1] * rest);
        out[q + 2] = encode(b / n + bg[2] * rest);
        out[q + 3] = 255;
      } else if (a > 0) {
        out[q] = encode(r / a);
        out[q + 1] = encode(g / a);
        out[q + 2] = encode(b / a);
        out[q + 3] = Math.round((a / n) * 255);
      } else {
        out[q] = out[q + 1] = out[q + 2] = out[q + 3] = 0;
      }
    }
  }
}

/** Resolves any CSS colour to 8 bit RGB. */
function parseColor(color: string): [number, number, number] {
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  if (!ctx) return [0, 0, 0];
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

/**
 * Yields to the event loop. Uses a MessageChannel instead of setTimeout or
 * requestAnimationFrame because those are throttled to about once per second
 * in background tabs, which would stall a long offline render.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

export function setCanvasSize(canvas: AnyCanvas, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}
