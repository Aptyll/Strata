/**
 * Paged particle storage.
 *
 * 50M particles at 8 bytes is 400 MB, which is over the default WebGPU limits
 * for a single buffer (256 MB) and a single storage binding (128 MB). Instead
 * of depending on raised limits, particles live in fixed-size pages and each
 * plane owns one contiguous range inside one page. A plane is then a single
 * compute dispatch over [base, base + count) of its page.
 *
 * Planes are never moved. Released ranges go to a per-page free list (first
 * fit, neighbours merged), so a streaming world can add and remove planes
 * forever without growing.
 */

import { BYTES_PER_PARTICLE } from './packing';

export interface ParticleRange {
  page: number;
  base: number;
  count: number;
}

export interface ParticlePage {
  buffer: GPUBuffer;
  /** Free ranges as [base, count], sorted by base, never adjacent. */
  free: [number, number][];
}

/** Default page: 2^23 particles = 64 MB, inside default WebGPU limits. */
export const DEFAULT_PAGE_PARTICLES = 1 << 23;

export class ParticlePool {
  readonly pages: ParticlePage[] = [];
  readonly pageParticles: number;
  private total = 0;

  constructor(
    private readonly device: GPUDevice,
    pageParticles = DEFAULT_PAGE_PARTICLES,
  ) {
    const maxByBinding = Math.floor(device.limits.maxStorageBufferBindingSize / BYTES_PER_PARTICLE);
    const maxByBuffer = Math.floor(device.limits.maxBufferSize / BYTES_PER_PARTICLE);
    this.pageParticles = Math.max(1, Math.min(pageParticles, maxByBinding, maxByBuffer));
  }

  get particleCount(): number {
    return this.total;
  }

  get byteSize(): number {
    return this.pages.length * this.pageParticles * BYTES_PER_PARTICLE;
  }

  /** Largest plane this pool can hold. */
  get maxRange(): number {
    return this.pageParticles;
  }

  allocate(count: number): ParticleRange {
    if (count < 1 || count > this.pageParticles) {
      throw new Error(
        `ParticlePool: a plane needs 1..${this.pageParticles} particles, got ${count}. ` +
          'Split larger planes or raise pageParticles.',
      );
    }
    for (let page = 0; page < this.pages.length; page++) {
      const free = this.pages[page].free;
      for (let i = 0; i < free.length; i++) {
        const [base, size] = free[i];
        if (size < count) continue;
        if (size === count) free.splice(i, 1);
        else free[i] = [base + count, size - count];
        this.total += count;
        return { page, base, count };
      }
    }
    this.pages.push({
      buffer: this.device.createBuffer({
        label: `strata-perf particles page ${this.pages.length}`,
        size: this.pageParticles * BYTES_PER_PARTICLE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }),
      free: count < this.pageParticles ? [[count, this.pageParticles - count]] : [],
    });
    this.total += count;
    return { page: this.pages.length - 1, base: 0, count };
  }

  /** Returns a range to its page. Pages themselves are kept for reuse. */
  release(range: ParticleRange): void {
    const free = this.pages[range.page].free;
    let i = 0;
    while (i < free.length && free[i][0] < range.base) i++;
    free.splice(i, 0, [range.base, range.count]);
    if (i + 1 < free.length && free[i][0] + free[i][1] === free[i + 1][0]) {
      free[i][1] += free[i + 1][1];
      free.splice(i + 1, 1);
    }
    if (i > 0 && free[i - 1][0] + free[i - 1][1] === free[i][0]) {
      free[i - 1][1] += free[i][1];
      free.splice(i, 1);
    }
    this.total -= range.count;
  }

  destroy(): void {
    for (const p of this.pages) p.buffer.destroy();
    this.pages.length = 0;
    this.total = 0;
  }
}
