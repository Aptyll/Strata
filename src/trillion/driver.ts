// Paces a whole frame through TrillionKernel: many short submits so no single
// one gets near the ~2 s Windows GPU timeout, interleaved across planes so a
// partial frame is an unbiased preview of the full one.

import type { TrillionKernel, TrillionPlane, TrillionTally } from './kernel';

export interface FrameOptions {
  /** Target GPU time per submit. Default 200 ms. */
  targetMs?: number;
  /** First submit size in particles. Default 2^24. */
  startBudget?: number;
  /** Each plane is split into this many interleaved rounds. Default 16. */
  rounds?: number;
  /** Called after each submit with the fraction done (by particles). */
  onProgress?(done: number, total: number, particlesPerSecond: number): void;
  signal?: AbortSignal;
  /** Skip clearing the counters (to add a frame on top of another). */
  keep?: boolean;
}

/** Renders all particles of `planes` into the kernel's counters, folded, and returns the tally. */
export async function renderFrame(kernel: TrillionKernel, planes: readonly TrillionPlane[], opts: FrameOptions = {}): Promise<TrillionTally> {
  const device = kernel.device;
  const targetMs = opts.targetMs ?? 200;
  const rounds = Math.max(1, opts.rounds ?? 16);
  let budget = opts.startBudget ?? 2 ** 24;
  const total = planes.reduce((s, p) => s + p.count, 0);

  // Work list: round r of every plane, in order.
  const work: { plane: TrillionPlane; start: number; end: number }[] = [];
  for (let r = 0; r < rounds; r++) {
    for (const plane of planes) {
      const a = Math.floor((plane.count * r) / rounds);
      const b = Math.floor((plane.count * (r + 1)) / rounds);
      if (b > a) work.push({ plane, start: a, end: b });
    }
  }

  if (!opts.keep) {
    const enc = device.createCommandEncoder();
    kernel.clear(enc);
    device.queue.submit([enc.finish()]);
    kernel.submitted();
  }

  let done = 0;
  let item = 0;
  while (item < work.length) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const enc = device.createCommandEncoder();
    let n = 0;
    while (item < work.length && n < budget) {
      const w = work[item];
      const take = Math.min(w.end - w.start, budget - n);
      kernel.encodeBatch(enc, { plane: w.plane, start: w.start, count: take });
      w.start += take;
      n += take;
      if (w.start >= w.end) item++;
    }
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    kernel.submitted();
    await device.queue.onSubmittedWorkDone();
    const ms = Math.max(1, performance.now() - t0);
    done += n;
    opts.onProgress?.(done, total, (n / ms) * 1000);
    // Steer the next submit toward targetMs, at most doubling per step.
    budget = Math.max(2 ** 16, Math.min(budget * 2, Math.floor(budget * (targetMs / ms))));
  }

  const enc = device.createCommandEncoder();
  kernel.fold(enc);
  device.queue.submit([enc.finish()]);
  kernel.submitted();
  return kernel.readTally();
}
