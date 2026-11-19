import type { FrameContext, GpuContext, Pass } from "../core/contracts";
import { BASIC_TONE_WGSL, FULLSCREEN_VS_WGSL } from "../gpu/wgsl";
import { DEFAULT_TONE, createDensityTonemapPass } from "../render";

/** The `?tonemap=basic` pass: basicTone on each channel of the HDR target. */
export const BASIC_TONEMAP_WGSL = /* wgsl */ `
${FULLSCREEN_VS_WGSL}
${BASIC_TONE_WGSL}
@group(0) @binding(0) var hdr: texture_2d<f32>;

@fragment
fn fs(i: VSOut) -> @location(0) vec4f {
  // Overlapping particles add up; basicTone maps the unbounded sum smoothly to white.
  let light = textureLoad(hdr, vec2i(i.pos.xy), 0).rgb;
  return vec4f(basicTone(light.r), basicTone(light.g), basicTone(light.b), 1.0);
}
`;

/**
 * Maps the HDR accumulation target to the canvas.
 *
 * Default: the density look from src/render (log tone curve, subtle bloom,
 * short trails; see docs/render.md), so thousands of overlapping particles
 * read as a gradient instead of flat white. Tune it live from the console
 * through `strataLook`, for example `strataLook.tone.white = 400`.
 *
 * `?tonemap=basic` in the URL selects the plain exponential curve below.
 */
export default function createTonemapPass(gpu: GpuContext): Pass {
  if (new URLSearchParams(globalThis.location?.search ?? "").get("tonemap") !== "basic") {
    const pass = createDensityTonemapPass({
      settings: {
        // Particles add `brightness` (1 by default) each: one particle is a
        // dim grey dot (55 of 255) and about 64 on one pixel reach full white.
        // Contrast 2.2 cancels the sRGB encode's second brightening of the
        // log curve, so each doubling of density is one equal step on screen,
        // as in the 1T grade (docs/briefs/visual/V02-tone-curve-lifts-mid-greys.md).
        // The Esc menu's contrast slider changes it live.
        tone: { ...DEFAULT_TONE, exposure: 2, white: 128, contrast: 2.2 },
        trails: { enabled: true, mode: "max", halfLife: 0.08 },
      },
    });
    pass.name = "tonemap";
    pass.resize(gpu, Math.max(1, gpu.canvas.width), Math.max(1, gpu.canvas.height));
    Object.assign(globalThis, { strataLook: pass.post!.settings });
    return pass;
  }
  return createBasicTonemapPass(gpu);
}

function createBasicTonemapPass(gpu: GpuContext): Pass {
  const { device } = gpu;
  const module = device.createShaderModule({ label: "tonemap", code: BASIC_TONEMAP_WGSL });
  const pipeline = device.createRenderPipeline({
    label: "tonemap",
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: gpu.canvasFormat }] },
    primitive: { topology: "triangle-list" },
  });
  let bound: GPUTextureView | null = null;
  let bindGroup: GPUBindGroup | null = null;

  return {
    name: "tonemap",
    stage: "tonemap",
    execute(frame: FrameContext) {
      if (bound !== frame.hdrView || !bindGroup) {
        bound = frame.hdrView;
        bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: frame.hdrView }],
        });
      }
      const pass = frame.encoder.beginRenderPass({
        label: "tonemap",
        colorAttachments: [{ view: frame.canvasView, loadOp: "clear", storeOp: "store" }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    },
  };
}
