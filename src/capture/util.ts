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

function make2d(width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('capture: could not create a 2D context');
  return { canvas, ctx };
}

/**
 * Copies and (optionally) downscales a canvas into a 2D canvas.
 *
 * The copy of the source happens synchronously in `draw`, which matters for
 * WebGPU and WebGL canvases: their contents are only readable in the same task
 * that rendered them.
 *
 * Downscaling by more than 2x is done in successive halvings. A single
 * bilinear `drawImage` only reads 4 source texels per output pixel, which would
 * skip most particles when going from, say, 4x supersampling to 1x. Halving
 * gives a proper box filter so every source pixel contributes.
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

  draw(source: CanvasImageSource, sourceWidth?: number, sourceHeight?: number): void {
    let src: CanvasImageSource = source;
    let sw = sourceWidth ?? (source as ImageBitmap).width;
    let sh = sourceHeight ?? (source as ImageBitmap).height;
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
