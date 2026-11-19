/**
 * What is known about the GPU the app runs on, as plain facts for the menu.
 *
 * WebGPU names the adapter by vendor and architecture ("nvidia turing");
 * Chrome leaves the product name out unless developer features are on. The
 * browser's WebGL renderer string usually does carry the product name
 * ("NVIDIA GeForce RTX 2070"), so it is offered next to the adapter, labelled
 * as coming from WebGL: on a machine with two GPUs the two APIs can differ.
 */
import { PARTICLE_STRIDE } from "../../gpu/shaderLib";

export interface GpuFacts {
  /** Vendor, architecture, and device and description when the browser shares them. */
  adapter: string;
  /** True for a software renderer. No speed number means anything on one. */
  software: boolean;
  /** The device can time GPU passes. */
  timestamps: boolean;
  /** Largest single buffer and storage binding, in bytes. */
  maxBufferBytes: number;
  maxBindingBytes: number;
  /** Most particles one sheet can hold: one sheet is one buffer. */
  maxSheetParticles: number;
}

export function readGpuFacts(device: GPUDevice): GpuFacts {
  // GPUDevice.adapterInfo is recent; older browsers only have it on the adapter.
  const info = (device as { adapterInfo?: GPUAdapterInfo }).adapterInfo;
  const adapter =
    [info?.vendor, info?.architecture, info?.device, info?.description].filter(Boolean).join(" ") || "unknown adapter";
  const maxBufferBytes = device.limits.maxBufferSize;
  const maxBindingBytes = device.limits.maxStorageBufferBindingSize;
  return {
    adapter,
    software: info?.isFallbackAdapter === true || /swiftshader|llvmpipe|software|basic render/i.test(adapter),
    timestamps: device.features.has("timestamp-query"),
    maxBufferBytes,
    maxBindingBytes,
    maxSheetParticles: Math.floor(Math.min(maxBufferBytes, maxBindingBytes) / PARTICLE_STRIDE),
  };
}

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 (0x00001F02) Direct3D11 vs_5_0 ps_5_0, D3D11)" to "NVIDIA GeForce RTX 2070". */
export function tidyRendererName(raw: string): string {
  const angle = /^ANGLE \((.*)\)$/.exec(raw.trim());
  if (!angle) return raw.trim();
  const parts = angle[1].split(", ");
  return (parts[1] ?? parts[0])
    .replace(/^ANGLE Metal Renderer: /i, "")
    .replace(/\s*\(0x[0-9a-f]+\)/gi, "")
    .replace(/\s+(Direct3D\d*|OpenGL|Vulkan|Metal)\b.*$/i, "")
    .trim();
}

/**
 * The GPU's name as the browser's WebGL reports it, or null when WebGL is
 * off or hides it. Makes a throwaway context, so call it once and keep the answer.
 */
export function webglRendererName(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const raw: unknown = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof raw === "string" && raw ? tidyRendererName(raw) : null;
  } catch {
    return null;
  }
}
