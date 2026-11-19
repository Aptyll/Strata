/**
 * Plugs capture into the engine's frame graph as a `capture` stage pass.
 *
 * ```ts
 * const capture = createCapturePass(gpu.canvas, { onStatus });
 * graph.add(capture);
 * // P saves a PNG, R records; or capture.controller.requestScreenshot() etc.
 * ```
 *
 * A pass runs while the frame is still being encoded, before it is submitted,
 * and the canvas can only be read after the submit. So `execute` defers the
 * capture to a microtask: that runs as soon as the frame callback returns,
 * which is after the submit but still inside the same task, while the canvas
 * holds the finished frame. This relies on the frame being encoded and
 * submitted synchronously, which is how FrameGraph.run works.
 */
import type { Pass } from '../core/contracts';
import { type CaptureController, type CaptureControllerOptions, createCaptureController } from './controller';
import type { AnyCanvas } from './util';

export interface CapturePass extends Pass {
  readonly controller: CaptureController;
}

export function createCapturePass(canvas: AnyCanvas, opts: CaptureControllerOptions = {}): CapturePass {
  const controller = createCaptureController(canvas, opts);
  let queued = false;
  return {
    name: 'capture',
    stage: 'capture',
    controller,
    execute() {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        controller.afterRender();
      });
    },
    dispose() {
      controller.dispose();
    },
  };
}
