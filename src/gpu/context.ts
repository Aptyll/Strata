/**
 * Device setup for the engine, and the helpers every engine path shares:
 *
 *   requestGpuDevice        a device with the large buffer limits (the app and the perf bench)
 *   initGpu                 the app's GpuContext: device, canvas, bind group layouts, Globals buffer
 *   compileComputePipeline  shader module + compute pipeline, logging WGSL errors with line numbers
 *   writeGlobals            uploads one frame's Globals uniform
 */

import type { GpuContext } from "../core/contracts";
import { adapterOptions } from "./adapter-options";
import { GLOBALS_SIZE, packGlobals, type GlobalsValues } from "./shaderLib";

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
  // Timestamps cost nothing until a query is written. The Esc menu's perf page uses them
  // to show GPU time per pass (src/ux/perf-hud); without the feature it shows frame time only.
  const device = await requestGpuDevice({ timestamps: true });
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

/** One Globals uniform, packed on the CPU. writeBuffer copies it at call time, so it is reused. */
const globalsBlock = new DataView(new ArrayBuffer(GLOBALS_SIZE));

/** Uploads one frame's Globals uniform (layout and packGlobals in ./shaderLib.ts). */
export function writeGlobals(gpu: GpuContext, g: GlobalsValues): void {
  packGlobals(globalsBlock, 0, g);
  gpu.device.queue.writeBuffer(gpu.globalsBuffer, 0, globalsBlock.buffer);
}
