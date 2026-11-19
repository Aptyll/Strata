/**
 * PNG stills: plain screenshots, supersampled stills and tiled poster renders.
 *
 * All of these copy the canvas synchronously, so call them right after the
 * engine has drawn (same task). WebGPU canvases read back as blank otherwise.
 */
import {
  type AnyCanvas,
  FilterStage,
  MAX_CANVAS_AREA,
  MAX_CANVAS_SIDE,
  Resampler,
  cssFilterOf,
  downloadBlob,
  setCanvasSize,
  timestampName,
} from './util';
import type { FrameImage } from './recorder';

export interface StillOptions {
  /** Download the file when done. Default false (the blob is just returned). */
  download?: boolean;
  /** File name for the download. Default `strata-YYYYMMDD-HHMMSS.png`. */
  filename?: string;
  /** Colour painted under the image. Default black. Use null to keep alpha. */
  background?: string | null;
  /**
   * CSS filter baked into the image. Default: the canvas element's own
   * computed filter (the app's color themes), so the file looks like the
   * screen. Null saves the raw canvas pixels.
   */
  filter?: string | null;
}

function finish(blob: Blob, opts: StillOptions): Blob {
  if (opts.download) downloadBlob(blob, opts.filename ?? timestampName('strata', 'png'));
  return blob;
}

/** The CSS filter to bake in: the one asked for, else the source canvas element's own. */
function filterFor(opts: StillOptions, source: unknown): string | null {
  return opts.filter === undefined ? cssFilterOf(source) : opts.filter;
}

/** Encodes the finished image as a PNG, through the CSS filter if there is one. */
async function encodePNG(image: Resampler, filter: string | null): Promise<Blob> {
  if (!filter) return image.toBlob();
  const stage = new FilterStage();
  stage.draw(image.canvas, image.width, image.height, filter);
  return stage.toBlob();
}

/**
 * Screenshot of the canvas as it is right now, at its current resolution.
 * Must be called in the same task that rendered the frame. Also accepts an
 * ImageBitmap or VideoFrame (which it closes).
 */
export async function capturePNG(image: FrameImage, opts: StillOptions = {}): Promise<Blob> {
  const [w, h] = sizeOf(image);
  const filter = filterFor(opts, image);
  const out = new Resampler(w, h, opts.background === undefined ? '#000' : opts.background);
  out.draw(image, w, h);
  closeIfFrame(image);
  return finish(await encodePNG(out, filter), opts);
}

const isFrame = (image: FrameImage): image is VideoFrame =>
  typeof VideoFrame !== 'undefined' && image instanceof VideoFrame;

function sizeOf(image: FrameImage): [number, number] {
  return isFrame(image) ? [image.displayWidth, image.displayHeight] : [image.width, image.height];
}

function closeIfFrame(image: FrameImage): void {
  if (isFrame(image)) image.close();
}

/**
 * Optional hook shared by the still functions: supplies the rendered image
 * instead of reading the canvas (see TextureReader). VideoFrames are closed
 * after use.
 */
export type CaptureHook = () => FrameImage | Promise<FrameImage>;

export interface SupersampledStillOptions extends StillOptions {
  canvas: AnyCanvas;
  /** Output width in pixels. Default: the current canvas width. */
  width?: number;
  /** Output height in pixels. Default: the current canvas height. */
  height?: number;
  /**
   * Render at `supersample` times the output size per axis, then box filter
   * down. 2 means 4 rendered pixels per output pixel. Default 2.
   */
  supersample?: number;
  /**
   * Draws one frame into the canvas at its (temporarily changed) size.
   * It must finish drawing synchronously; the canvas is copied the moment it
   * returns. The engine needs to pick up the new canvas size (reconfigure its
   * depth and intermediate targets) inside this call.
   */
  render: (size: { width: number; height: number }) => void;
  /** Supplies the rendered image instead of reading the canvas. */
  capture?: CaptureHook;
  /** Largest canvas side the GPU can render to. Default 8192 (WebGPU baseline). */
  maxRenderSize?: number;
}

/**
 * Renders a still at a chosen resolution with supersampling, without touching
 * the on-screen layout: the canvas backing store is resized for one frame and
 * then restored. For images larger than the GPU texture limit, use
 * {@link captureTiledPNG}.
 */
export async function captureStillPNG(opts: SupersampledStillOptions): Promise<Blob> {
  const { canvas, render } = opts;
  const width = Math.round(opts.width ?? canvas.width);
  const height = Math.round(opts.height ?? canvas.height);
  const ss = opts.supersample ?? 2;
  const maxSide = opts.maxRenderSize ?? 8192;
  const rw = Math.round(width * ss);
  const rh = Math.round(height * ss);
  if (rw > maxSide || rh > maxSide) {
    throw new RangeError(
      `capture: ${rw}x${rh} exceeds the ${maxSide}px render limit. ` +
        `Lower supersample or use captureTiledPNG().`,
    );
  }
  const filter = filterFor(opts, canvas);
  const prevW = canvas.width;
  const prevH = canvas.height;
  const out = new Resampler(width, height, opts.background === undefined ? '#000' : opts.background);
  try {
    setCanvasSize(canvas, rw, rh);
    render({ width: rw, height: rh });
    if (opts.capture) {
      const image = await opts.capture();
      out.draw(image, ...sizeOf(image));
      closeIfFrame(image);
    } else {
      out.draw(canvas);
    }
  } finally {
    setCanvasSize(canvas, prevW, prevH);
  }
  return finish(await encodePNG(out, filter), opts);
}

export interface Tile {
  index: number;
  count: number;
  /** Pixel rectangle of this tile in the rendered (supersampled) image. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Size of the full rendered image, for sizing things in pixels consistently. */
  fullWidth: number;
  fullHeight: number;
  /**
   * Column-major 4x4 matrix to multiply in front of the projection matrix
   * (`tileMatrix * projection`). It zooms clip space so that this tile fills
   * the whole viewport.
   */
  matrix: Float32Array;
  /** The same transform as scale and offset: `clip.xy = clip.xy * scale + offset * clip.w`. */
  scale: [number, number];
  offset: [number, number];
}

export interface TiledStillOptions extends StillOptions {
  canvas: AnyCanvas;
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  /** Supersampling factor per axis. Default 1. */
  supersample?: number;
  /** Rendered tile side in pixels. Default 4096. */
  tileSize?: number;
  /**
   * Draws the scene for one tile, synchronously. Apply `tile.matrix` in front
   * of the projection matrix. Anything sized in screen pixels (point sprites)
   * should be sized against `tile.fullWidth/fullHeight`, not the tile.
   */
  render: (tile: Tile) => void;
  /** Supplies each rendered tile instead of reading the canvas. */
  capture?: CaptureHook;
  onProgress?: (done: number, total: number) => void;
}

/** Computes the tile layout and clip-space transforms. Exposed for testing and custom loops. */
export function computeTiles(fullWidth: number, fullHeight: number, tileSize: number): Tile[] {
  const nx = Math.ceil(fullWidth / tileSize);
  const ny = Math.ceil(fullHeight / tileSize);
  const tiles: Tile[] = [];
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const x = tx * tileSize;
      const y = ty * tileSize;
      const width = Math.min(tileSize, fullWidth - x);
      const height = Math.min(tileSize, fullHeight - y);
      const sx = fullWidth / width;
      const sy = fullHeight / height;
      // Tile centre in full-image NDC (y up).
      const cx = (2 * x + width) / fullWidth - 1;
      const cy = 1 - (2 * y + height) / fullHeight;
      const ox = -cx * sx;
      const oy = -cy * sy;
      // prettier-ignore
      const matrix = new Float32Array([
        sx, 0, 0, 0,
        0, sy, 0, 0,
        0, 0, 1, 0,
        ox, oy, 0, 1,
      ]);
      tiles.push({
        index: tiles.length,
        count: nx * ny,
        x,
        y,
        width,
        height,
        fullWidth,
        fullHeight,
        matrix,
        scale: [sx, sy],
        offset: [ox, oy],
      });
    }
  }
  return tiles;
}

/**
 * Renders an image larger than the GPU can draw in one pass (for example a
 * 16K poster) by rendering it tile by tile and stitching the result.
 */
export async function captureTiledPNG(opts: TiledStillOptions): Promise<Blob> {
  const { canvas, render } = opts;
  const ss = opts.supersample ?? 1;
  const width = Math.round(opts.width);
  const height = Math.round(opts.height);
  const fullW = Math.round(width * ss);
  const fullH = Math.round(height * ss);
  if (fullW > MAX_CANVAS_SIDE || fullH > MAX_CANVAS_SIDE || fullW * fullH > MAX_CANVAS_AREA) {
    throw new RangeError(`capture: ${fullW}x${fullH} is larger than a browser canvas can hold.`);
  }
  const background = opts.background === undefined ? '#000' : opts.background;
  const filter = filterFor(opts, canvas);
  const tiles = computeTiles(fullW, fullH, opts.tileSize ?? 4096);
  const stitched = new Resampler(fullW, fullH, null);
  if (background) stitched.fill(background);
  const prevW = canvas.width;
  const prevH = canvas.height;
  try {
    for (const tile of tiles) {
      setCanvasSize(canvas, tile.width, tile.height);
      render(tile);
      if (opts.capture) {
        const image = await opts.capture();
        stitched.blit(image, tile.x, tile.y, tile.width, tile.height);
        closeIfFrame(image);
      } else {
        stitched.blit(canvas, tile.x, tile.y, tile.width, tile.height);
      }
      opts.onProgress?.(tile.index + 1, tile.count);
      // Let the GPU process drain between tiles.
      await new Promise((r) => setTimeout(r));
    }
  } finally {
    setCanvasSize(canvas, prevW, prevH);
  }
  if (ss === 1) return finish(await encodePNG(stitched, filter), opts);
  const out = new Resampler(width, height, background);
  out.draw(stitched.canvas);
  return finish(await encodePNG(out, filter), opts);
}
