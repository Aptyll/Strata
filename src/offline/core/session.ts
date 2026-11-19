/**
 * Render session: the resumable frame loop, shared by the Node runner and the
 * browser page.
 *
 * Output directory layout (flat):
 *   job.json             the expanded job, written once
 *   frame-000123.png     16-bit log frame (see develop.ts)
 *   frame-000123.json    stats for that frame. Written last: its presence
 *                        means the frame is complete.
 *   partial-000123.bin   checkpoint of a frame in progress
 *
 * Frames are independent of each other, so a render can stop at any moment
 * and continue later, run out of order, or be split across several machines.
 */
import { develop, frameStats, type FrameStats } from "./develop";
import { DEFAULT_LOOK, drawLabel, exposureTrack, gradeFrame, toneTable, withCommas, type Look } from "./grade";
import { totalParticles, type OfflineJob } from "./job";
import { pcg } from "./laws";
import { decodeGrayPng16, encodeGrayPng, type Zlib } from "./png";
import { StatelessRenderer, type Accumulation, type FrameCursor, type RendererOptions } from "./renderer";

/** A directory of files. Implemented over node:fs and over the browser's File System Access API. */
export interface FileStore {
  read(name: string): Promise<Uint8Array | null>;
  /** Must be atomic: a reader never sees a half-written file. */
  write(name: string, data: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

const pad = (n: number): string => String(n).padStart(6, "0");
export const frameImageName = (f: number): string => `frame-${pad(f)}.png`;
export const frameStatsName = (f: number): string => `frame-${pad(f)}.json`;
export const partialName = (f: number): string => `partial-${pad(f)}.bin`;

const text = new TextEncoder();
const untext = new TextDecoder();

/** Cheap fingerprint of a job, to refuse resuming a checkpoint from a different one. */
export function jobFingerprint(job: OfflineJob): number {
  const s = JSON.stringify(job);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = pcg((h ^ s.charCodeAt(i)) >>> 0);
  return h >>> 0;
}

// Version 3: landed tally in header words 6 and 7, GPU evaluated count in 8 and 9.
const PARTIAL_MAGIC = 0x53545243;
const PARTIAL_HEADER_WORDS = 10;

function packPartial(job: OfflineJob, frame: number, cursor: FrameCursor, { lo, hi, landed, gpuEvaluated }: Accumulation): Uint8Array {
  const out = new Uint32Array(PARTIAL_HEADER_WORDS + lo.length + hi.length);
  const split = (v: bigint) => [Number(v & 0xffffffffn), Number(v >> 32n)];
  out.set([PARTIAL_MAGIC, jobFingerprint(job), frame, cursor.plane, cursor.offset, lo.length, ...split(landed), ...split(gpuEvaluated)]);
  out.set(lo, PARTIAL_HEADER_WORDS);
  out.set(hi, PARTIAL_HEADER_WORDS + lo.length);
  return new Uint8Array(out.buffer);
}

function unpackPartial(
  job: OfflineJob,
  frame: number,
  file: Uint8Array,
): ({ cursor: FrameCursor } & Accumulation) | null {
  if (file.byteLength < PARTIAL_HEADER_WORDS * 4 || file.byteLength % 4) return null;
  const words = new Uint32Array(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const cells = job.width * job.height * job.ssaa * job.ssaa;
  if (words[0] !== PARTIAL_MAGIC || words[1] !== jobFingerprint(job) || words[2] !== frame) return null;
  if (words[5] !== cells || words.length !== PARTIAL_HEADER_WORDS + 2 * cells) return null;
  return {
    cursor: { plane: words[3], offset: words[4] },
    lo: words.slice(PARTIAL_HEADER_WORDS, PARTIAL_HEADER_WORDS + cells),
    hi: words.slice(PARTIAL_HEADER_WORDS + cells),
    landed: BigInt(words[6]) + (BigInt(words[7]) << 32n),
    gpuEvaluated: BigInt(words[8]) + (BigInt(words[9]) << 32n),
  };
}

export interface RenderOptions extends RendererOptions {
  /** Frames to render, [first, end). Defaults to the whole clip. */
  first?: number;
  end?: number;
  /** Render only frames where frame % shardCount === shardIndex. For splitting a clip across machines. */
  shardIndex?: number;
  shardCount?: number;
  /** Save a partial frame this often, in seconds. 0 disables. */
  checkpointSeconds?: number;
  /** Return true to stop cleanly after the current batch or frame. */
  shouldStop?(): boolean;
  /** Aborting rejects with an AbortError after the current batch. Progress is kept as a checkpoint. */
  signal?: AbortSignal;
  /** Progressive preview of the frame in progress, every previewSeconds (default 15). */
  onPartial?(frame: number, acc: Accumulation, done: number, total: number): void | Promise<void>;
  previewSeconds?: number;
  onProgress?(p: {
    frame: number;
    done: number;
    total: number;
    /** Particles per second, smoothed over recent batches. */
    rate: number;
    batchSize: number;
    batchMs: number;
  }): void;
  onFrame?(stats: FrameStats, resumed: boolean): void;
}

/** Write job.json, or check that the directory belongs to this job. */
export async function claimDirectory(store: FileStore, job: OfflineJob): Promise<void> {
  const existing = await store.read("job.json");
  const mine = JSON.stringify(job);
  if (existing) {
    if (untext.decode(existing) !== mine) {
      throw new Error("The output directory holds a different job. Use a new directory, or delete this one to start over.");
    }
    return;
  }
  await store.write("job.json", text.encode(mine));
}

export async function loadJob(store: FileStore): Promise<OfflineJob> {
  const file = await store.read("job.json");
  if (!file) throw new Error("No job.json in the output directory. Render first.");
  return JSON.parse(untext.decode(file)) as OfflineJob;
}

/** Render every missing frame. Safe to call again after any interruption. */
export async function renderJob(
  device: GPUDevice,
  job: OfflineJob,
  store: FileStore,
  zlib: Zlib,
  opts: RenderOptions = {},
): Promise<{ rendered: number; skipped: number; stopped: boolean }> {
  await claimDirectory(store, job);
  const renderer = await StatelessRenderer.create(device, job, opts);
  const first = opts.first ?? 0;
  const end = Math.min(opts.end ?? job.frames, job.frames);
  const shardCount = opts.shardCount ?? 1;
  const shardIndex = opts.shardIndex ?? 0;
  let rendered = 0;
  let skipped = 0;
  let stopped = false;
  try {
    for (let frame = first; frame < end; frame++) {
      if (frame % shardCount !== shardIndex) continue;
      if (opts.shouldStop?.()) {
        stopped = true;
        break;
      }
      if (await store.read(frameStatsName(frame))) {
        skipped++;
        continue;
      }
      const partialFile = await store.read(partialName(frame));
      const resume = partialFile ? (unpackPartial(job, frame, partialFile) ?? undefined) : undefined;

      let rate = 0;
      const result = await renderer.renderFrame(frame, {
        resume,
        signal: opts.signal,
        onPartial: opts.onPartial
          ? { everyMs: (opts.previewSeconds ?? 15) * 1000, show: (acc, done, total) => opts.onPartial!(frame, acc, done, total) }
          : undefined,
        checkpoint:
          (opts.checkpointSeconds ?? 300) > 0
            ? {
                everyMs: (opts.checkpointSeconds ?? 300) * 1000,
                save: (cursor, acc) => store.write(partialName(frame), packPartial(job, frame, cursor, acc)),
              }
            : undefined,
        onProgress: (done, total, batchSize, batchMs) => {
          const r = batchSize / Math.max(batchMs / 1000, 1e-6);
          rate = rate === 0 ? r : rate * 0.9 + r * 0.1;
          opts.onProgress?.({ frame, done, total, rate, batchSize, batchMs });
        },
      });

      // The GPU's own count must match the world, or the frame is not what it claims.
      if (result.gpuEvaluated !== BigInt(renderer.total)) {
        throw new Error(`Frame ${frame}: the GPU evaluated ${result.gpuEvaluated} particles, expected ${renderer.total}`);
      }
      const developed = develop(result.lo, result.hi, job.width, job.height, job.ssaa);
      const stats = frameStats(frame, result, developed, {
        evaluated: result.gpuEvaluated,
        evaluatedBy: renderer.evaluatedBy,
        seconds: result.seconds,
        batches: result.batches,
      });
      await store.write(frameImageName(frame), await encodeGrayPng(developed.codes, job.width, job.height, zlib));
      await store.write(frameStatsName(frame), text.encode(JSON.stringify(stats)));
      if (partialFile) await store.remove(partialName(frame));
      rendered++;
      opts.onFrame?.(stats, resume !== undefined);
    }
  } finally {
    renderer.dispose();
  }
  return { rendered, skipped, stopped };
}

export interface GradeOptions {
  look?: Partial<Look>;
  /** Lines burned into the bottom-left corner. Pass [] for none. Default: the honest label. */
  label?: string[] | ((stats: FrameStats, job: OfflineJob) => string[]);
}

export function defaultLabel(stats: FrameStats, job: OfflineJob): string[] {
  const lines: string[] = [
    `${withCommas(totalParticles(job))} particles, every one evaluated every frame`,
    "Stateless: closed-form motion, nothing stored per particle",
  ];
  return [...lines, `In frame: ${withCommas(stats.landed)}`];
}

/** Stats of every completed frame from frame 0 up to the first missing one. */
export async function loadStats(store: FileStore, job: OfflineJob): Promise<FrameStats[]> {
  const all: FrameStats[] = [];
  for (let f = 0; f < job.frames; f++) {
    const file = await store.read(frameStatsName(f));
    if (!file) break;
    all.push(JSON.parse(untext.decode(file)) as FrameStats);
  }
  return all;
}

/**
 * Grade completed frames in order and hand each finished 8-bit gray frame to
 * `sink` (an encoder). Stops at the first missing frame.
 */
export async function gradeJob(
  store: FileStore,
  zlib: Zlib,
  sink: (frame: number, gray: Uint8Array, job: OfflineJob) => Promise<void>,
  opts: GradeOptions = {},
  range: { first?: number; end?: number } = {},
): Promise<{ frames: number; job: OfflineJob }> {
  const job = await loadJob(store);
  const stats = await loadStats(store, job);
  const look: Look = { ...DEFAULT_LOOK, ...opts.look };
  const white = exposureTrack(stats, look);
  const first = range.first ?? 0;
  const end = Math.min(range.end ?? stats.length, stats.length);
  let frames = 0;
  for (let f = first; f < end; f++) {
    const file = await store.read(frameImageName(f));
    if (!file) throw new Error(`Missing ${frameImageName(f)}`);
    const { samples, width, height } = await decodeGrayPng16(file, zlib);
    if (width !== job.width || height !== job.height) throw new Error(`${frameImageName(f)} has the wrong size`);
    const gray = gradeFrame(samples, toneTable(white[f], look), f);
    const label = typeof opts.label === "function" ? opts.label(stats[f], job) : (opts.label ?? defaultLabel(stats[f], job));
    if (label.length) drawLabel(gray, width, height, label);
    await sink(f, gray, job);
    frames++;
  }
  return { frames, job };
}
