/**
 * Device setup for the engine, and the helpers every engine path shares:
 *
 *   requestGpuDevice        a device with the large buffer limits (the app and the perf bench)
 *   initGpu                 the app's GpuContext: device, canvas, bind group layouts, Globals buffer
 *   compileComputePipeline  shader module + compute pipeline, logging WGSL errors with line numbers
 *   writeGlobals            uploads one frame's Globals uniform
 */

import type { GpuContext } from "../core/contracts";
import { BRUSH_FLOATS, MAX_BRUSHES } from "../core/contracts";
import { GLOBALS_BRUSHES_OFFSET, GLOBALS_SIZE } from "./shaderLib";
import { adapterOptions } from "./adapter-options";

export const HDR_FORMAT: GPUTextureFormat = "rgba16float";

export interface GpuDeviceOptions {
  /** Also ask for 'timestamp-query' when the adapter has it (GPU pass timing). Default false. */
  timestamps?: boolean;
}

/**
 * The high-performance adapter's device, with maxBufferSize and
 * maxStorageBufferBindingSize raised to what the adapter allows, so one
 * storage buffer can hold far more than the default 128 MiB binding.
 * Throws a readable error when WebGPU or an adapter is missing.
 */
export async function requestGpuDevice(opts: GpuDeviceOptions = {}): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error("WebGPU is not available in this browser.");
  const adapter = await navigator.gpu.requestAdapter(adapterOptions());
  if (!adapter) throw new Error("No WebGPU adapter found.");
  const requiredFeatures: GPUFeatureName[] = [];
  if (opts.timestamps && adapter.features.has("timestamp-query")) requiredFeatures.push("timestamp-query");
  return adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
}

export async function initGpu(canvas: HTMLCanvasElement): Promise<GpuContext> {
  const device = await requestGpuDevice();
  device.lost.then((info) => console.error("WebGPU device lost:", info.message));

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Could not create a WebGPU canvas context.");
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: canvasFormat, alphaMode: "opaque" });

  const layouts = {
    globals: device.createBindGroupLayout({
      label: "globals",
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      }],
    }),
    planeSim: device.createBindGroupLayout({
      label: "plane-sim",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    }),
    planeRender: device.createBindGroupLayout({
      label: "plane-render",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    }),
  };

  const globalsBuffer = device.createBuffer({
    label: "globals",
    size: GLOBALS_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const globalsBindGroup = device.createBindGroup({
    layout: layouts.globals,
    entries: [{ binding: 0, resource: { buffer: globalsBuffer } }],
  });

  return { device, canvas, context, canvasFormat, hdrFormat: HDR_FORMAT, layouts, globalsBuffer, globalsBindGroup };
}

/**
 * Compiles `code` into a compute pipeline with entry point `main`. WGSL
 * errors are logged as `[label] line N: message`; `label` also names the
 * module and pipeline in browser GPU errors.
 */
export function compileComputePipeline(
  device: GPUDevice,
  label: string,
  code: string,
  layout: GPUPipelineLayout,
): GPUComputePipeline {
  const module = device.createShaderModule({ label, code });
  module.getCompilationInfo().then((info) => {
    for (const m of info.messages) {
      if (m.type === "error") console.error(`[${label}] line ${m.lineNum}: ${m.message}`);
    }
  });
  return device.createComputePipeline({ label, layout, compute: { module, entryPoint: "main" } });
}

export interface FrameGlobals {
  viewProj: Float32Array;
  time: number;
  dt: number;
  frame: number;
  brightness: number;
  /**
   * Packed pointer brushes: MAX_BRUSHES x BRUSH_FLOATS floats, laid out as
   * Brush in src/core/contracts.ts. Omit for no pointer forces.
   */
  brushes?: Float32Array;
}

const scratch = new ArrayBuffer(GLOBALS_SIZE);
const scratchF32 = new Float32Array(scratch);
const scratchU32 = new Uint32Array(scratch);

export function writeGlobals(gpu: GpuContext, g: FrameGlobals): void {
  scratchF32.set(g.viewProj, 0);
  scratchF32[16] = g.time;
  scratchF32[17] = g.dt;
  scratchU32[18] = g.frame;
  scratchF32[19] = g.brightness;
  const base = GLOBALS_BRUSHES_OFFSET / 4;
  if (g.brushes) {
    scratchF32.set(g.brushes.subarray(0, MAX_BRUSHES * BRUSH_FLOATS), base);
  } else {
    scratchF32.fill(0, base, base + MAX_BRUSHES * BRUSH_FLOATS);
    for (let k = 0; k < MAX_BRUSHES; k++) scratchF32[base + k * BRUSH_FLOATS + 6] = -1;
  }
  gpu.device.queue.writeBuffer(gpu.globalsBuffer, 0, scratch);
}
