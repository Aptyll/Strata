/**
 * Per-sheet hue: every plane draws in its own color.
 *
 * The color themes (src/ux/theme) are a gradient map on the finished frame,
 * so they cannot tell sheets apart. This module colors inside the frame graph
 * instead, with two passes and no change to the shared tone map:
 *
 *   sheet-hue       stage `rasterize`. One-pixel additive points, like the
 *                   `points` rasterizer, but each fragment writes
 *                   (light, light * hue.rgb) into the rgba16float HDR target.
 *                   Red stays plain density, so the density tone map, trails
 *                   and bloom (which read only .r) work exactly as before.
 *                   Green, blue and alpha carry color-weighted density.
 *   sheet-hue-tint  stage `ui`, right after the tone map. Reads the color
 *                   channels back, turns them into a chroma (largest channel
 *                   = 1) and multiplies the canvas by it with a blend state.
 *                   Overlapping sheets mix by how much light each adds.
 *                   Pixels with no current particles (bloom halos, trails)
 *                   stay neutral.
 *
 * Opt in with `?raster=hue`, or pick "points, one hue per sheet" in the Esc
 * menu's rasterizer setting. The tint pass follows the rasterizer: it runs only
 * while sheet-hue is the enabled rasterize pass.
 *
 * Cost: the same as the `points` rasterizer plus one fullscreen pass. The hue
 * comes from the plane's seed, so a sheet keeps its color across frames and
 * rebuilds of the same scene.
 *
 * Limits: the HDR target is f16, so colors stop adding past ~2048 hits per
 * pixel, the same cap as the points path. A grey theme filter on the canvas
 * (any theme other than "white") replaces these colors with its own ramp.
 */
import type { FrameContext, GpuContext, Pass } from "../core/contracts";
import { FULLSCREEN_VS_WGSL } from "../gpu/wgsl";
import { GLOBALS_WGSL, PARTICLE_STRIDE, PLANE_STRUCT_WGSL } from "../gpu/shaderLib";

/** Saturated hue from the plane seed. Shared by both passes' docs; used in the raster shader. */
const HUE_WGSL = /* wgsl */ `
fn sheetHue(seed: f32) -> vec3f {
  // Seeds are uniform in [0, 1); scramble them so neighbouring seeds get far apart hues.
  let h = fract(seed * 7.61803 + 0.137);
  let k = vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0);
  let rgb = clamp(abs(fract(vec3f(h) + k) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  // Saturation 0.8: vivid, but a lone particle on a dark sheet is still visible.
  return mix(vec3f(1.0), rgb, 0.8);
}
`;

export const SHEET_HUE_RASTER_WGSL = /* wgsl */ `
${GLOBALS_WGSL}
${PLANE_STRUCT_WGSL}
${HUE_WGSL}
@group(1) @binding(0) var<uniform> plane: Plane;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) light: f32,
  @location(1) @interpolate(flat) hue: vec3f,
}

@vertex
fn vs(@location(0) pos: vec2f) -> VsOut {
  var out: VsOut;
  out.position = globals.viewProj * plane.model * vec4f(pos, 0.0, 1.0);
  out.light = globals.brightness * plane.brightness;
  out.hue = sheetHue(plane.seed);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(in.light, in.light * in.hue);
}
`;

export const SHEET_HUE_TINT_WGSL = /* wgsl */ `
${FULLSCREEN_VS_WGSL}
@group(0) @binding(0) var hdr: texture_2d<f32>;

@fragment
fn fs(i: VSOut) -> @location(0) vec4f {
  let v = textureLoad(hdr, vec2i(i.pos.xy), 0);
  let c = max(v.gba, vec3f(0.0));
  let m = max(c.r, max(c.g, c.b));
  if (!(m > 0.0) || m > 1.0e30) { return vec4f(1.0); } // no particles here (or inf): leave the pixel as is
  return vec4f(c / m, 1.0);
}
`;

export const SHEET_HUE_PASS = "sheet-hue";

/** The rasterize pass and its tint pass. Register both; pick the first with the rasterizer choice. */
export function createSheetHuePasses(gpu: GpuContext): [Pass, Pass] {
  const { device, layouts } = gpu;

  const rasterModule = device.createShaderModule({ label: "sheet-hue", code: SHEET_HUE_RASTER_WGSL });
  const rasterPipeline = device.createRenderPipeline({
    label: "sheet-hue",
    layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.globals, layouts.planeRender] }),
    vertex: {
      module: rasterModule,
      entryPoint: "vs",
      buffers: [{ arrayStride: PARTICLE_STRIDE, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
    },
    fragment: {
      module: rasterModule,
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

  const raster: Pass = {
    name: SHEET_HUE_PASS,
    stage: "rasterize",
    enabled: false,
    execute(frame: FrameContext) {
      const pass = frame.encoder.beginRenderPass({
        label: "sheet-hue",
        colorAttachments: [{ view: frame.hdrView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
      });
      pass.setPipeline(rasterPipeline);
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

  const tintModule = device.createShaderModule({ label: "sheet-hue-tint", code: SHEET_HUE_TINT_WGSL });
  const tintPipeline = device.createRenderPipeline({
    label: "sheet-hue-tint",
    layout: "auto",
    vertex: { module: tintModule, entryPoint: "vs" },
    fragment: {
      module: tintModule,
      entryPoint: "fs",
      targets: [{
        format: gpu.canvasFormat,
        // canvas = canvas * chroma; alpha untouched.
        blend: {
          color: { srcFactor: "dst", dstFactor: "zero" },
          alpha: { srcFactor: "zero", dstFactor: "one" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });
  let bound: GPUTextureView | null = null;
  let bindGroup: GPUBindGroup | null = null;

  const tint: Pass = {
    name: "sheet-hue-tint",
    stage: "ui",
    // Follows the rasterizer choice, which sets `raster.enabled`.
    get enabled() {
      return raster.enabled === true;
    },
    execute(frame: FrameContext) {
      if (bound !== frame.hdrView || !bindGroup) {
        bound = frame.hdrView;
        bindGroup = device.createBindGroup({ layout: tintPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: frame.hdrView }] });
      }
      const pass = frame.encoder.beginRenderPass({
        label: "sheet-hue-tint",
        colorAttachments: [{ view: frame.canvasView, loadOp: "load", storeOp: "store" }],
      });
      pass.setPipeline(tintPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    },
  };

  return [raster, tint];
}
