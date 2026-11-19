/**
 * Options for navigator.gpu.requestAdapter().
 *
 * Chrome on Windows ignores powerPreference and logs a console warning when it
 * is passed (https://crbug.com/369219127), so it is left out there. Elsewhere
 * (dual-GPU laptops, Macs) it still picks the faster GPU.
 */
export function adapterOptions(): GPURequestAdapterOptions {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Windows/i.test(ua) ? {} : { powerPreference: "high-performance" };
}
