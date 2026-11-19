import type { GpuContext } from "../core/contracts";
import { GLOBALS_SIZE } from "./shaderLib";

export const HDR_FORMAT: GPUTextureFormat = "rgba16float";


export async function initGpu(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!navigator.gpu) throw new Error("WebGPU is not available in this browser.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter found.");
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
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

export interface FrameGlobals {
  viewProj: Float32Array;
  time: number;
  dt: number;
  frame: number;
  brightness: number;
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
  gpu.device.queue.writeBuffer(gpu.globalsBuffer, 0, scratch);
}
