/**
 * Paged particle storage.
 *
 * 50M particles at 8 bytes is 400 MB, which is over the default WebGPU limits
 * for a single buffer (256 MB) and a single storage binding (128 MB). Instead
 * of depending on raised limits, particles live in fixed-size pages and each
 * plane owns one contiguous range inside one page. A plane is then a single
 * compute dispatch over [base, base + count) of its page.
 *
 * Allocation is a bump allocator: planes are never moved, and ranges are not
 * recycled yet (see docs/perf.md, "Not done yet").
 */

import { BYTES_PER_PARTICLE } from './packing';

export interface ParticleRange {
  page: number;
  base: number;
  count: number;
}

export interface ParticlePage {
  buffer: GPUBuffer;
  used: number;
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
    let page = this.pages.length - 1;
    if (page < 0 || this.pages[page].used + count > this.pageParticles) {
      this.pages.push({
        buffer: this.device.createBuffer({
          label: `strata-perf particles page ${this.pages.length}`,
          size: this.pageParticles * BYTES_PER_PARTICLE,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        }),
        used: 0,
      });
      page = this.pages.length - 1;
    }
    const p = this.pages[page];
    const range = { page, base: p.used, count };
    p.used += count;
    this.total += count;
    return range;
  }

  destroy(): void {
    for (const p of this.pages) p.buffer.destroy();
    this.pages.length = 0;
    this.total = 0;
  }
}
