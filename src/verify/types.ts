/**
 * Verify harness types.
 *
 * A verify case is a small check that runs against a real WebGPU device: it
 * compiles shaders, runs them, reads buffers back and compares against a CPU
 * reference. Cases live next to the code they check, in files named
 * `*.verify.ts` anywhere under src/, and are picked up automatically.
 *
 *   import type { VerifyCase } from "../verify/types";
 *   const cases: VerifyCase[] = [{ name: "my-pass matches CPU", async run(t) { ... } }];
 *   export default cases;
 *
 * See src/verify/README.md.
 */

export interface VerifyContext {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  /** True on a software adapter (SwiftShader). Timing-sensitive checks should skip. */
  readonly software: boolean;
  /** Attach a note to the report without failing (lint findings, measured error, ...). */
  note(message: string): void;
  /** Mark the case skipped, with a reason. Throws to unwind. */
  skip(reason: string): never;
}

export interface VerifyCase {
  name: string;
  /** Throw (any Error) to fail. GPU validation errors raised while running also fail the case. */
  run(t: VerifyContext): Promise<void> | void;
}

export type VerifyStatus = "pass" | "fail" | "skip";

export interface VerifyResult {
  /** Source file of the case, repo-relative. */
  file: string;
  name: string;
  status: VerifyStatus;
  ms: number;
  /** Failure or skip reason. */
  message?: string;
  notes: string[];
}

export interface VerifyReport {
  done: boolean;
  adapter: string;
  software: boolean;
  results: VerifyResult[];
  passed: number;
  failed: number;
  skipped: number;
}

export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

export class VerifySkip extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "VerifySkip";
  }
}
