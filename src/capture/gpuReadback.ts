/**
 * Reads a rendered WebGPU texture back to the CPU as a VideoFrame.
 *
 * Capturing the canvas element directly is the simplest path and what the
 * recorder does by default. This is the alternative for when the image to
 * record is a texture: an offscreen target, a higher resolution than the
 * canvas, or a canvas whose contents the browser will not hand back. It is
 * exact (no browser colour management in between) and does not depend on
 * capturing in the same task as the render.
 */

export interface PendingRead {
  /**
   * Resolves with the pixels once the GPU has finished the copy. Call it
   * after the command encoder passed to `copy` has been submitted. The caller
   * owns the frame: pass it to `recorder.addFrame(frame)` (which closes it)
   * or close it yourself.
   */
  frame(timestampMicros?: number): Promise<VideoFrame>;
}

const FORMATS: Partial<Record<GPUTextureFormat, VideoPixelFormat>> = {
  rgba8unorm: 'RGBX',
  'rgba8unorm-srgb': 'RGBX',
  bgra8unorm: 'BGRX',
  'bgra8unorm-srgb': 'BGRX',
};

export class TextureReader {
  private pool: GPUBuffer[] = [];

  constructor(private readonly device: GPUDevice) {}

  /**
   * Encodes a copy of `texture` into `encoder`. The texture must be an 8 bit
   * RGBA or BGRA format with COPY_SRC usage. For the canvas texture that
   * means configuring the context with
   * `usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC`.
   */
  copy(encoder: GPUCommandEncoder, texture: GPUTexture): PendingRead {
    const format = FORMATS[texture.format];
    if (!format) throw new Error(`capture: cannot read back a ${texture.format} texture.`);
    const { width, height } = texture;
    const stride = Math.ceil((width * 4) / 256) * 256;
    const size = stride * height;
    const buffer = this.acquire(size);
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride, rowsPerImage: height }, [width, height]);
    return {
      frame: async (timestampMicros = 0) => {
        try {
          await buffer.mapAsync(GPUMapMode.READ, 0, size);
          // The VideoFrame constructor copies the data, so the buffer can be
          // unmapped and reused straight away.
          return new VideoFrame(new Uint8Array(buffer.getMappedRange(0, size)), {
            format,
            codedWidth: width,
            codedHeight: height,
            layout: [{ offset: 0, stride }],
            timestamp: timestampMicros,
            colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true },
          });
        } finally {
          if (buffer.mapState !== 'unmapped') buffer.unmap();
          this.pool.push(buffer);
        }
      },
    };
  }

  /** Convenience: copies a texture with its own command buffer and waits for the pixels. */
  read(texture: GPUTexture, timestampMicros = 0): Promise<VideoFrame> {
    const encoder = this.device.createCommandEncoder();
    const pending = this.copy(encoder, texture);
    this.device.queue.submit([encoder.finish()]);
    return pending.frame(timestampMicros);
  }

  private acquire(size: number): GPUBuffer {
    const i = this.pool.findIndex((b) => b.size >= size);
    if (i >= 0) return this.pool.splice(i, 1)[0];
    return this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }

  dispose(): void {
    for (const b of this.pool) b.destroy();
    this.pool = [];
  }
}
