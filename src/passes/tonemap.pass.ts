import type { FrameContext, GpuContext, Pass } from "../core/contracts";
import { DEFAULT_TONE, createDensityTonemapPass } from "../render";

const WGSL = /* wgsl */ `
@group(0) @binding(0) var hdr: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // Fullscreen triangle.
  return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let light = textureLoad(hdr, vec2i(p.xy), 0).rgb;
  // Overlapping particles add up; this maps the unbounded sum smoothly to white.
  let mapped = 1.0 - exp(-light);
  return vec4f(pow(mapped, vec3f(1.0 / 2.2)), 1.0);
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
        // clear grey dot and about 64 on one pixel reach full white.
        tone: { ...DEFAULT_TONE, exposure: 2, white: 128 },
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
  const module = device.createShaderModule({ label: "tonemap", code: WGSL });
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
