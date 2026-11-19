/**
 * GPU-side helpers for verify cases: device setup, shader compilation with
 * readable errors, error scopes, buffer readback and a one-call compute
 * runner.
 */

import { particleScaleLimits } from "./limits";
import { VerifyError } from "./types";

export interface VerifyDevice {
  adapter: GPUAdapter;
  device: GPUDevice;
  /** Short adapter description for the report. */
  description: string;
  software: boolean;
}

/**
 * Requests a device the way the app should: default limits except the two
 * buffer size limits, which are raised to what the adapter offers.
 */
export async function acquireDevice(): Promise<VerifyDevice> {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    throw new VerifyError("WebGPU is not available in this browser (navigator.gpu is missing)");
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new VerifyError("navigator.gpu.requestAdapter() returned no adapter");
  const device = await adapter.requestDevice({ requiredLimits: particleScaleLimits(adapter) });
  const info = adapter.info;
  const description = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" ") || "unknown";
  const software = /swiftshader|llvmpipe|software|basic render/i.test(description);
  return { adapter, device, description, software };
}

/**
 * Runs `fn` and throws if it raised any validation, out-of-memory or internal
 * GPU error. WebGPU reports these asynchronously and silently by default, so
 * wrap anything whose validity matters.
 */
export async function expectNoGpuError<T>(device: GPUDevice, fn: () => T | Promise<T>): Promise<T> {
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("internal");
  let result: T;
  let thrown: unknown;
  try {
    result = await fn();
  } catch (e) {
    thrown = e;
  }
  const errors = [await device.popErrorScope(), await device.popErrorScope(), await device.popErrorScope()];
  if (thrown !== undefined) throw thrown;
  const messages = errors.filter((e): e is GPUError => e !== null).map((e) => `${e.constructor.name}: ${e.message}`);
  if (messages.length > 0) throw new VerifyError(messages.join("\n"));
  return result!;
}

/** Runs `fn` and returns the GPU validation error it raised, or null. For negative tests. */
export async function captureValidationError(device: GPUDevice, fn: () => unknown): Promise<string | null> {
  device.pushErrorScope("validation");
  try {
    await fn();
  } finally {
    // Fall through to pop the scope even if fn threw synchronously.
  }
  const error = await device.popErrorScope();
  return error ? error.message : null;
}

export interface CompileResult {
  module: GPUShaderModule;
  /** Compiler warnings, formatted with line numbers. */
  warnings: string[];
}

function formatMessage(code: string, m: GPUCompilationMessage): string {
  const line = code.split("\n")[m.lineNum - 1] ?? "";
  return `${m.type} at ${m.lineNum}:${m.linePos}: ${m.message}\n    ${line.trim()}`;
}

/**
 * Compiles WGSL and throws with line numbers and the offending source lines
 * if the compiler reports any error. Returns warnings instead of dropping them.
 */
export async function compile(device: GPUDevice, code: string, label = "shader"): Promise<CompileResult> {
  // createShaderModule also raises a validation error on bad WGSL. Swallow it
  // here: the compilation info below carries the same error with a position.
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code, label });
  const info = await module.getCompilationInfo();
  const scopeError = await device.popErrorScope();
  const errors = info.messages.filter((m) => m.type === "error");
  if (errors.length > 0) {
    throw new VerifyError(`${label} does not compile:\n${errors.map((m) => formatMessage(code, m)).join("\n")}`);
  }
  if (scopeError) throw new VerifyError(`${label} does not compile: ${scopeError.message}`);
  return { module, warnings: info.messages.filter((m) => m.type === "warning").map((m) => formatMessage(code, m)) };
}

/** Copies a buffer range back to the CPU. The buffer needs COPY_SRC usage. */
export async function readBuffer(device: GPUDevice, buffer: GPUBuffer, offset = 0, size?: number): Promise<ArrayBuffer> {
  const bytes = size ?? buffer.size - offset;
  // copyBufferToBuffer and mapping need multiples of 4.
  const padded = Math.ceil(bytes / 4) * 4;
  const staging = device.createBuffer({ size: padded, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, offset, staging, 0, padded);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0, bytes);
  staging.unmap();
  staging.destroy();
  return copy;
}

export interface ComputeBinding {
  group?: number;
  binding: number;
  /** How the shader declares it: var<uniform>, var<storage, read> or var<storage, read_write>. */
  access: "uniform" | "read" | "read_write";
  /** Initial contents, or a byte size for a zero-filled buffer. */
  data: ArrayBufferView | number;
}

export interface ComputeRun {
  code: string;
  entryPoint?: string;
  bindings: readonly ComputeBinding[];
  /** dispatchWorkgroups arguments. */
  dispatch: readonly [number, number?, number?];
  /** How many times to dispatch, each in its own pass. Default 1. */
  steps?: number;
  /** Pipeline-overridable constants. */
  constants?: Record<string, number>;
  label?: string;
}

/**
 * Compiles a compute shader, binds the given buffers, dispatches, and returns
 * the final contents of every storage buffer, keyed by "group.binding" (or
 * just "binding" for group 0). Any compile or validation error throws.
 *
 * The pipeline uses an auto layout, so every binding listed here must be
 * used by the entry point.
 */
export async function runCompute(device: GPUDevice, run: ComputeRun): Promise<Map<string, ArrayBuffer>> {
  const label = run.label ?? "compute";
  const { module } = await compile(device, run.code, label);
  return expectNoGpuError(device, async () => {
    const pipeline = await device.createComputePipelineAsync({
      label,
      layout: "auto",
      compute: { module, entryPoint: run.entryPoint, constants: run.constants },
    });
    const buffers = run.bindings.map((b) => {
      const bytes = typeof b.data === "number" ? b.data : b.data.byteLength;
      const buffer = device.createBuffer({
        label: `${label} ${b.group ?? 0}.${b.binding}`,
        size: Math.max(4, Math.ceil(bytes / 4) * 4),
        usage:
          (b.access === "uniform" ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
      });
      if (typeof b.data !== "number") {
        device.queue.writeBuffer(buffer, 0, b.data.buffer, b.data.byteOffset, b.data.byteLength);
      }
      return { ...b, group: b.group ?? 0, bytes, buffer };
    });
    const groups = [...new Set(buffers.map((b) => b.group))].sort((a, b) => a - b);
    const bindGroups = groups.map((g) => ({
      index: g,
      bindGroup: device.createBindGroup({
        layout: pipeline.getBindGroupLayout(g),
        entries: buffers.filter((b) => b.group === g).map((b) => ({ binding: b.binding, resource: { buffer: b.buffer } })),
      }),
    }));
    const encoder = device.createCommandEncoder({ label });
    for (let step = 0; step < (run.steps ?? 1); step++) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      for (const g of bindGroups) pass.setBindGroup(g.index, g.bindGroup);
      pass.dispatchWorkgroups(run.dispatch[0], run.dispatch[1] ?? 1, run.dispatch[2] ?? 1);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
    const out = new Map<string, ArrayBuffer>();
    for (const b of buffers) {
      if (b.access !== "uniform") {
        out.set(b.group === 0 ? `${b.binding}` : `${b.group}.${b.binding}`, await readBuffer(device, b.buffer, 0, b.bytes));
      }
      b.buffer.destroy();
    }
    return out;
  });
}

/** Looks up a runCompute output and throws a clear error when the key is wrong. */
export function output(outputs: Map<string, ArrayBuffer>, key: string | number): ArrayBuffer {
  const buffer = outputs.get(`${key}`);
  if (!buffer) throw new VerifyError(`no output for binding ${key} (have ${[...outputs.keys()].join(", ")})`);
  return buffer;
}
