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
  seconds: number;
  batches: number;
  particlesPerSecond: number;
  gridHash: string;
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
  grade: Record<string, unknown> | null;
  totals: { framesComplete: number; allEvaluated: boolean; evaluated: string; gpuSeconds: number; particlesPerSecond: number };
  frames: ManifestFrame[];
  fullJob: JobLike | null;
}

export const MANIFEST_KIND: "strata-render-manifest";
export const MANIFEST_VERSION: 1;
export function sha256OfText(s: string): Promise<string>;
export function sha256OfBytes(bytes: Uint8Array): Promise<string>;
export function gridFields(s: FrameStatsLike): Pick<FrameStatsLike, "evaluated" | "landed" | "unitSum" | "litPixels" | "maxCode" | "hist">;
export function gridHash(s: FrameStatsLike): Promise<string>;
export function totalParticles(job: JobLike): number;
export function buildManifest(input: ManifestInput): Promise<RenderManifest>;
export function compareManifests(
  reference: RenderManifest,
  candidate: RenderManifest,
): { ok: boolean; checked: number; missing: number[]; problems: string[] };
