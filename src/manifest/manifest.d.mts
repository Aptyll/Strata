/** Types for manifest.mjs. Structural, so src/offline types fit without an import. */

export interface FrameStatsLike {
  frame: number;
  evaluated: string;
  unitSum: string;
  landed: string;
  litPixels: number;
  maxCode: number;
  hist: number[];
  seconds: number;
  batches: number;
  resumes?: number;
  /** Who counted evaluated: "gpu", or "host" in old trillion-kernel stats that summed dispatch sizes. */
  evaluatedBy?: "gpu" | "host";
  /** The kernel that rendered the frame (renderer.ts KernelChoice). */
  kernel?: string;
  /** SHA-256 commitment to the exact grid (src/offline/core/fingerprint.ts). */
  gridSha256?: string;
  /** 16 x 9 log-coded tile brightness (src/offline/core/fingerprint.ts). */
  signature?: number[];
}

export interface JobLike {
  name: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  ssaa: number;
  splat: string;
  weighting: string;
  planes: { seed: number; particleCount: number }[];
  camera: unknown[];
}

export interface GpuInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  /** Free text, for example the Dawn adapter name. */
  name?: string;
  /** The browser's user agent, for renders made in the browser. */
  browser?: string;
}

export interface ManifestInput {
  job: JobLike;
  /** GPU-written stats of each finished frame. */
  stats: FrameStatsLike[];
  commit?: string | null;
  renderer?: string;
  /** How it was launched, for example the app URL or the CLI command. */
  entry?: string | null;
  gpu?: GpuInfo | null;
  host?: { userAgent?: string; platform?: string; node?: string } | null;
  /** src/offline/core/session.ts jobFingerprint, when the caller has it. */
  jobFingerprint?: number | null;
  /** The grade (Look) used for the published picture. */
  look?: Record<string, unknown> | null;
  started?: string | null;
  finished?: string | null;
  /** sha256 of each frame's 16-bit PNG, by frame number. */
  imageSha256?: Record<number, string>;
  /** Default true: embed the whole job so the manifest alone can reproduce the render. */
  includeJob?: boolean;
  /** The published video file, so a download can be checked against the manifest. */
  video?: VideoInfo | null;
}

export interface VideoInfo {
  /** File name, without folders. */
  file: string;
  bytes: number;
  sha256: string;
}

export interface ManifestFrame {
  frame: number;
  evaluated: string;
  landed: string;
  outside: string;
  unitSum: string;
  litPixels: number;
  maxCode: number;
  allEvaluated: boolean;
  /** count + point only: grid sum is exactly landed x 65536. null when not provable (flux or bilinear). */
  eachLandedAddedOnce: boolean | null;
  /** Grid light in particles (unitSum / 65536), as a decimal string. Exact for count, expected total for flux. */
  lightParticles: string;
  /** GPU wall seconds and dispatches for the whole frame, summed over every run of it. */
  seconds: number;
  batches: number;
  /**
   * Times the frame was continued from a checkpoint (0: one run). null: the
   * stats predate this field, so if the frame was continued, `seconds` covers
   * only its last run and `particlesPerSecond` is too high.
   */
  resumes: number | null;
  particlesPerSecond: number;
  gridHash: string;
  /** SHA-256 commitment to the exact 64-bit grid. null in stats written before it existed, or without WebCrypto. */
  gridSha256: string | null;
  /** 16 x 9 tile brightness, round(256 log2(1 + particles in tile)), for comparing renders across GPU models. */
  signature: number[] | null;
  /** Who counted evaluated. null in stats written before the field existed (the GPU-counting kernel). */
  evaluatedBy: "gpu" | "host" | null;
  /** The kernel that rendered the frame; null in stats written before the field existed. `verify` re-renders with it. */
  kernel: string | null;
  imageSha256: string | null;
}

export interface RenderManifest {
  kind: "strata-render-manifest";
  version: 1;
  mode: "rendered-stateless";
  wording: string;
  created: string;
  started: string | null;
  finished: string | null;
  source: { repo: string; commit: string | null; renderer: string; entry: string | null };
  gpu: GpuInfo | null;
  host: ManifestInput["host"];
  job: {
    name: string;
    sha256: string;
    fingerprint: number | null;
    width: number;
    height: number;
    fps: number;
    frames: number;
    ssaa: number;
    splat: string;
    weighting: string;
    planes: number;
    seeds: { first: number | null; last: number | null; count: number; unique: number };
    camera: unknown[];
  };
  particlesPerFrame: number;
  drawing: { weighting: string; splat: string; exact: boolean; meaning: string };
  grade: Record<string, unknown> | null;
  totals: {
    framesComplete: number;
    allEvaluated: boolean;
    evaluated: string;
    eachLandedAddedOnce: boolean | null;
    /** true: the GPU counted every frame; false: the host counted some frame (old trillion-kernel stats); null: not recorded. */
    countedOnGpu: boolean | null;
    gpuSeconds: number;
    particlesPerSecond: number;
  };
  frames: ManifestFrame[];
  video: VideoInfo | null;
  fullJob: JobLike | null;
}

export interface FrameVerdict {
  frame: number;
  /** identical: same exact grid. same picture: what another GPU model gives. different: fails. */
  verdict: "identical" | "same picture" | "different";
  reasons: string[];
  /** Relative L1 distance of the tile signatures; null when either frame lacks one. */
  signatureDistance: number | null;
  /** |landed - landed'| / max of the two. */
  landedDifference: number;
}

export interface ManifestComparison {
  ok: boolean;
  checked: number;
  /** Frames of the candidate the reference does not have. */
  missing: number[];
  problems: string[];
  frames: FrameVerdict[];
  identical: number;
  samePicture: number;
  different: number;
}

export interface ManifestCheck {
  id: string;
  /** true passes, false fails, null is a note. */
  ok: boolean | null;
  detail: string;
}

export const MANIFEST_KIND: "strata-render-manifest";
export const MANIFEST_VERSION: 1;
export function sha256OfText(s: string): Promise<string>;
export function sha256OfBytes(bytes: Uint8Array): Promise<string>;
export function gridFields(s: FrameStatsLike): Pick<FrameStatsLike, "evaluated" | "landed" | "unitSum" | "litPixels" | "maxCode" | "hist">;
export function gridHash(s: FrameStatsLike): Promise<string>;
export function totalParticles(job: JobLike): number;
export function buildManifest(input: ManifestInput): Promise<RenderManifest>;
export const SAME_PICTURE: Readonly<{ signature: number; landed: number }>;
export function signatureDistance(a: readonly number[], b: readonly number[]): number;
export function gpuName(g: GpuInfo): string;
export function compareFrame(reference: ManifestFrame, candidate: ManifestFrame): FrameVerdict;
export function compareManifests(reference: RenderManifest, candidate: RenderManifest): ManifestComparison;
export function checkManifest(m: RenderManifest): Promise<ManifestCheck[]>;
