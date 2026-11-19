/**
 * GPU pass timing through the optional `timestamp-query` feature.
 * rAF frame time is capped by vsync, so this is the number that tells how
 * much headroom a configuration really has.
 */

export class GpuTimer {
  readonly supported: boolean;
  /** Latest resolved durations in milliseconds, one per pass slot. */
  readonly ms: Float64Array;

  private readonly querySet?: GPUQuerySet;
  private readonly resolveBuffer?: GPUBuffer;
  private readonly readBuffers: GPUBuffer[] = [];
  private pending: GPUBuffer | null = null;
  private readonly byteSize: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly passes: number,
  ) {
    this.supported = device.features.has('timestamp-query');
    this.ms = new Float64Array(passes);
    this.byteSize = passes * 2 * 8;
    if (!this.supported) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: passes * 2 });
    this.resolveBuffer = device.createBuffer({
      size: this.byteSize,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
  }

  /** Spread into a pass descriptor: `{ ...desc, timestampWrites: timer.writes(i) }`. */
  writes(pass: number): GPUComputePassTimestampWrites | undefined {
    if (!this.querySet) return undefined;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: pass * 2,
      endOfPassWriteIndex: pass * 2 + 1,
    };
  }

  /** Call after the last timed pass, before `encoder.finish()`. */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.querySet || !this.resolveBuffer) return;
    encoder.resolveQuerySet(this.querySet, 0, this.passes * 2, this.resolveBuffer, 0);
    if (this.pending) return; // a readback is still in flight, skip this frame
    const buf =
      this.readBuffers.pop() ??
      this.device.createBuffer({ size: this.byteSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, buf, 0, this.byteSize);
    this.pending = buf;
  }

  /** Call after `queue.submit()`. */
  readback(): void {
    const buf = this.pending;
    if (!buf || buf.mapState !== 'unmapped') return;
    buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new BigInt64Array(buf.getMappedRange());
        for (let i = 0; i < this.passes; i++) {
          const d = Number(t[i * 2 + 1] - t[i * 2]);
          if (d >= 0) this.ms[i] = d / 1e6;
        }
        buf.unmap();
        this.readBuffers.push(buf);
        this.pending = null;
      },
      () => {
        this.pending = null;
      },
    );
  }

  destroy(): void {
    this.querySet?.destroy();
    this.resolveBuffer?.destroy();
    for (const b of this.readBuffers) b.destroy();
  }
}
