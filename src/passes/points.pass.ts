import type { FrameContext, GpuContext, Pass } from "../core/contracts";
import { GLOBALS_WGSL, PARTICLE_STRIDE } from "../gpu/shaderLib";

const WGSL = /* wgsl */ `
${GLOBALS_WGSL}
struct Plane { model: mat4x4f }
@group(1) @binding(0) var<uniform> plane: Plane;

@vertex
fn vs(@location(0) pos: vec2f) -> @builtin(position) vec4f {
  return globals.viewProj * plane.model * vec4f(pos, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
  return vec4f(vec3f(globals.brightness), 1.0);
}
`;

/**
 * Draws every active particle as a one-pixel additive point into the HDR
 * target. Density reads as brightness, and because additive blending is order
 * independent there is no sorting and no depth buffer. Clears the target first.
 */
export default function createPointsPass(gpu: GpuContext): Pass {
  const { device, layouts } = gpu;
  const module = device.createShaderModule({ label: "points", code: WGSL });
  const pipeline = device.createRenderPipeline({
    label: "points",
    layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.globals, layouts.planeRender] }),
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [{
        arrayStride: PARTICLE_STRIDE,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
      }],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [{
        format: gpu.hdrFormat,
        blend: {
          color: { srcFactor: "one", dstFactor: "one" },
          alpha: { srcFactor: "one", dstFactor: "one" },
        },
      }],
    },
    primitive: { topology: "point-list" },
  });

  return {
    name: "points",
    stage: "rasterize",
    execute(frame: FrameContext) {
      const pass = frame.encoder.beginRenderPass({
        label: "points",
        colorAttachments: [{
          view: frame.hdrView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, gpu.globalsBindGroup);
      for (const plane of frame.planes) {
        if (plane.activeCount === 0) continue;
        pass.setBindGroup(1, plane.renderBindGroup);
        pass.setVertexBuffer(0, plane.particles);
        pass.draw(plane.activeCount);
      }
      pass.end();
    },
  };
}
