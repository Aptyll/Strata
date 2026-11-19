/**
 * Challenge engine as frame-graph passes (src/core/contracts.ts).
 *
 *   const engine = new ChallengeEngine({ device: gpu.device, width, height, planes: scene.planes });
 *   await engine.setCount(50_000_000);
 *   graph.add(...createChallengePasses(engine));
 *
 * The kernel runs in the `simulate` stage and the accumulation buffer is added
 * to the shared HDR target in the `rasterize` stage, so depth effects, tonemap,
 * UI and capture passes work on it like on any other particles.
 *
 * Not yet run against the shared engine, only type-checked against the contracts.
 */

import type { Pass } from "../core/contracts";
import type { ChallengeEngine } from "./engine";

export interface ChallengePassOptions {
  /** Light one particle adds to its pixel at the reference distance. Default 0.2. */
  brightness?: number;
  /** Clear the HDR target first. Set when no other rasterize pass runs before this one. */
  clear?: boolean;
}

export const createChallengePasses = (engine: ChallengeEngine, options: ChallengePassOptions = {}): Pass[] => [
  {
    name: "challenge-kernel",
    stage: "simulate",
    execute(frame) {
      engine.setSize(frame.width, frame.height);
      engine.encode(frame.encoder, {
        viewProj: frame.camera.viewProjection(frame.width / frame.height),
        time: frame.time,
        dt: frame.dt,
        frame: frame.frame,
      });
    },
  },
  {
    name: "challenge-resolve",
    stage: "rasterize",
    execute(frame) {
      engine.resolveToHdr(
        frame.encoder,
        frame.hdrView,
        frame.gpu.hdrFormat,
        options.brightness ?? 0.2,
        options.clear ?? false,
      );
    },
    dispose() {
      engine.dispose();
    },
  },
];
