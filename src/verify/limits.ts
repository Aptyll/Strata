/**
 * WebGPU limit arithmetic for very large particle counts. Pure functions, no
 * GPU needed, so both the app and the verify cases can use them.
 *
 * The three limits that bite first when a plane grows past a few million
 * particles (16 bytes each):
 *
 *   maxStorageBufferBindingSize  default 128 MiB  ->  8,388,608 particles per binding
 *   maxBufferSize                default 256 MiB  -> 16,777,216 particles per buffer
 *   maxComputeWorkgroupsPerDimension      65,535  ->  4,194,240 particles per 1D dispatch at workgroup_size(64)
 *
 * The first two are raised by asking for the adapter's limits in
 * requestDevice (see `particleScaleLimits`). The third cannot be raised in
 * practice, so large dispatches must be 2D (see `planDispatch`).
 */

/** Defaults every WebGPU device has unless requiredLimits asks for more. */
export const WEBGPU_DEFAULT_LIMITS = {
  maxBufferSize: 268_435_456,
  maxStorageBufferBindingSize: 134_217_728,
  maxUniformBufferBindingSize: 65_536,
  maxComputeWorkgroupsPerDimension: 65_535,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupStorageSize: 16_384,
  maxStorageBuffersPerShaderStage: 8,
  maxTextureDimension2D: 8192,
  maxBindGroups: 4,
} as const;

export type LimitName = keyof typeof WEBGPU_DEFAULT_LIMITS;
export type LimitValues = { readonly [K in LimitName]: number };

/** Bytes per particle in the shared layout (pos: vec2f, vel: vec2f). */
export const PARTICLE_BYTES = 16;

/**
 * requiredLimits to pass to adapter.requestDevice so that particle buffers
 * can be as large as the hardware allows. Only the size limits are raised;
 * everything else stays at the portable default.
 */
export function particleScaleLimits(adapter: { limits: GPUSupportedLimits }): Record<string, number> {
  return {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  };
}

/** Largest particle count one storage binding can expose under these limits. */
export function maxParticlesPerBinding(
  limits: Pick<LimitValues, "maxBufferSize" | "maxStorageBufferBindingSize">,
  bytesPerParticle: number = PARTICLE_BYTES,
): number {
  return Math.floor(Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize) / bytesPerParticle);
}

export interface DispatchPlan {
  /** dispatchWorkgroups(x, y). */
  x: number;
  y: number;
  /**
   * Invocations per row: x * workgroupSize. The shader computes the item index
   * as `gid.x + gid.y * rowStride` and must early-out when it is >= count.
   */
  rowStride: number;
  /** Invocations that run. Always >= count; the excess must early-out. */
  invocations: number;
}

/**
 * Splits `count` items into a 1D or 2D dispatch that respects
 * maxComputeWorkgroupsPerDimension, for a shader declared
 * `@workgroup_size(workgroupSize)` (or `(workgroupSize, 1, 1)`).
 *
 * The plan is tight: it wastes fewer than `y` workgroups. Use it with
 * DISPATCH_INDEX_WGSL and pass `rowStride` in a uniform.
 */
export function planDispatch(
  count: number,
  workgroupSize: number,
  maxPerDim: number = WEBGPU_DEFAULT_LIMITS.maxComputeWorkgroupsPerDimension,
): DispatchPlan {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`planDispatch: bad count ${count}`);
  if (!Number.isInteger(workgroupSize) || workgroupSize < 1) {
    throw new RangeError(`planDispatch: bad workgroupSize ${workgroupSize}`);
  }
  if (count > 0xffff_ffff) throw new RangeError(`planDispatch: count ${count} does not fit a u32 index`);
  const groups = Math.ceil(count / workgroupSize);
  if (groups === 0) return { x: 0, y: 0, rowStride: workgroupSize, invocations: 0 };
  const y = Math.ceil(groups / maxPerDim);
  if (y > maxPerDim) throw new RangeError(`planDispatch: ${count} items need more than ${maxPerDim}^2 workgroups`);
  const x = Math.ceil(groups / y);
  return { x, y, rowStride: x * workgroupSize, invocations: x * y * workgroupSize };
}

/**
 * WGSL companion to planDispatch. `rowStride` is DispatchPlan.rowStride.
 * The largest index produced is below count + y * workgroupSize, which stays
 * far inside u32 for any count a buffer can hold.
 */
export const DISPATCH_INDEX_WGSL = /* wgsl */ `
fn dispatchIndex(gid: vec3u, rowStride: u32) -> u32 {
  return gid.x + gid.y * rowStride;
}
`;

export interface LimitProblem {
  limit: LimitName;
  needed: number;
  allowed: number;
  message: string;
}

export interface ResourcePlan {
  /** Size of each buffer in bytes. */
  bufferBytes?: readonly number[];
  /** Size of each storage binding in bytes (the bound range, not the buffer). */
  storageBindingBytes?: readonly number[];
  /** Size of each uniform binding in bytes. */
  uniformBindingBytes?: readonly number[];
  /** Workgroup counts of each dispatchWorkgroups call. */
  dispatches?: readonly (readonly number[])[];
  /** @workgroup_size of each compute entry point. */
  workgroupSizes?: readonly (readonly number[])[];
  /** Width or height of each 2D texture. */
  textureDimensions?: readonly number[];
}

/**
 * Checks a planned set of resources against a set of limits and lists every
 * limit that would be exceeded. Use WEBGPU_DEFAULT_LIMITS to find out what
 * needs requiredLimits, or device.limits to find out what cannot run at all.
 */
export function checkLimits(plan: ResourcePlan, limits: LimitValues): LimitProblem[] {
  const problems: LimitProblem[] = [];
  const over = (limit: LimitName, needed: number, what: string): void => {
    const allowed = limits[limit];
    if (needed > allowed) {
      problems.push({ limit, needed, allowed, message: `${what}: ${needed} exceeds ${limit} (${allowed})` });
    }
  };
  plan.bufferBytes?.forEach((b, i) => over("maxBufferSize", b, `buffer ${i}`));
  plan.storageBindingBytes?.forEach((b, i) => over("maxStorageBufferBindingSize", b, `storage binding ${i}`));
  plan.uniformBindingBytes?.forEach((b, i) => over("maxUniformBufferBindingSize", b, `uniform binding ${i}`));
  plan.dispatches?.forEach((d, i) =>
    d.forEach((n, axis) => over("maxComputeWorkgroupsPerDimension", n, `dispatch ${i} axis ${"xyz"[axis]}`)),
  );
  plan.workgroupSizes?.forEach((w, i) => {
    const [x = 1, y = 1, z = 1] = w;
    over("maxComputeWorkgroupSizeX", x, `workgroup_size ${i} x`);
    over("maxComputeWorkgroupSizeY", y, `workgroup_size ${i} y`);
    over("maxComputeWorkgroupSizeZ", z, `workgroup_size ${i} z`);
    over("maxComputeInvocationsPerWorkgroup", x * y * z, `workgroup_size ${i} total`);
  });
  plan.textureDimensions?.forEach((d, i) => over("maxTextureDimension2D", d, `texture ${i}`));
  return problems;
}
