// What can this device do, and how much should we ask of it?
//
// detectCapability() answers two questions before anything is drawn:
//   1. Can we run the WebGPU engine at all? If not, why not, in terms a
//      person can act on.
//   2. If we can, how many particles is a sensible starting budget?
// The engine should treat the budget as a starting point and adapt from
// measured frame time. This only keeps the first seconds from stuttering.

import { adapterOptions } from '../../gpu/adapter-options';

export type GpuStatus = 'ok' | 'insecure-context' | 'no-api' | 'no-adapter' | 'device-failed';
export type Tier = 'low' | 'mid' | 'high';
export type Browser = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';
export type Os = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'other';

export interface Capability {
  status: GpuStatus;
  webgpu: boolean;
  tier: Tier;
  /** Suggested starting particle count. */
  particleBudget: number;
  /** Cap for devicePixelRatio. */
  maxPixelRatio: number;
  /** Primary input is a finger. */
  touch: boolean;
  /** A hovering pointer exists. */
  hover: boolean;
  reducedMotion: boolean;
  saveData: boolean;
  browser: Browser;
  os: Os;
  adapter: GPUAdapter | null;
}

/** The parts of the browser environment detection reads. Injectable for tests. */
export interface CapabilityEnv {
  navigator?: {
    userAgent?: string;
    maxTouchPoints?: number;
    deviceMemory?: number;
    hardwareConcurrency?: number;
    connection?: { saveData?: boolean };
    gpu?: { requestAdapter(options?: GPURequestAdapterOptions): Promise<unknown> };
  };
  matchMedia?: (query: string) => { matches: boolean };
  isSecureContext?: boolean;
}

export interface TierInput {
  touch?: boolean;
  os?: Os;
  memoryGb?: number;
  cores?: number;
  maxBufferSize?: number;
  saveData?: boolean;
  fallbackAdapter?: boolean;
}

export const BUDGETS = Object.freeze({
  low: 2_000_000,
  mid: 16_000_000,
  high: 64_000_000,
});

export function parseUserAgent(ua: string, maxTouchPoints = 0): { os: Os; browser: Browser } {
  const s = ua.toLowerCase();
  let os: Os = 'other';
  if (/iphone|ipad|ipod/.test(s) || (s.includes('macintosh') && maxTouchPoints > 1)) os = 'ios';
  else if (s.includes('android')) os = 'android';
  else if (s.includes('mac os x') || s.includes('macintosh')) os = 'macos';
  else if (s.includes('windows')) os = 'windows';
  else if (s.includes('linux') || s.includes('cros')) os = 'linux';

  let browser: Browser = 'other';
  if (s.includes('edg/')) browser = 'edge';
  else if (s.includes('firefox/') || s.includes('fxios')) browser = 'firefox';
  else if (s.includes('chrome/') || s.includes('crios') || s.includes('chromium')) browser = 'chrome';
  else if (s.includes('safari/')) browser = 'safari';
  return { os, browser };
}

/**
 * Pick a tier from what the adapter and the device report.
 * Deliberately conservative: starting low and growing looks like the world
 * filling in; starting high and dropping frames looks broken.
 */
export function chooseTier(input: TierInput): Tier {
  const { touch, os, memoryGb, cores, maxBufferSize, saveData, fallbackAdapter } = input;
  if (fallbackAdapter || saveData) return 'low';
  const phone = touch && (os === 'ios' || os === 'android');
  if (phone) return (memoryGb ?? 4) >= 6 && (cores ?? 4) >= 6 ? 'mid' : 'low';
  if ((maxBufferSize ?? 0) >= 2 ** 31 && (cores ?? 4) >= 8 && (memoryGb ?? 8) >= 8) return 'high';
  return 'mid';
}

/** @param env overrides for tests; defaults to the real browser */
export async function detectCapability(env: CapabilityEnv = {}): Promise<Capability> {
  const nav: NonNullable<CapabilityEnv['navigator']> =
    env.navigator ?? (globalThis.navigator as unknown as CapabilityEnv['navigator']) ?? {};
  const mm = env.matchMedia ??
    ((q: string) => (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(q) : { matches: false }));
  const secure = env.isSecureContext ?? globalThis.isSecureContext ?? true;
  const { os, browser } = parseUserAgent(nav.userAgent ?? '', nav.maxTouchPoints ?? 0);

  const touch = mm('(pointer: coarse)').matches;
  const hover = mm('(hover: hover)').matches;
  const reducedMotion = mm('(prefers-reduced-motion: reduce)').matches;
  const saveData = !!nav.connection?.saveData;

  let status: GpuStatus = 'ok';
  let adapter: GPUAdapter | null = null;
  if (!nav.gpu) {
    // The API is hidden on http:// pages, which looks identical to "unsupported".
    status = secure ? 'no-api' : 'insecure-context';
  } else {
    try {
      adapter = (await nav.gpu.requestAdapter(adapterOptions())) as GPUAdapter | null;
    } catch {
      adapter = null;
    }
    if (!adapter) status = 'no-adapter';
  }

  const tier = chooseTier({
    touch, os, saveData,
    memoryGb: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    maxBufferSize: adapter?.limits?.maxBufferSize,
    fallbackAdapter: isFallbackAdapter(adapter),
  });

  return {
    status,
    webgpu: status === 'ok',
    tier,
    particleBudget: BUDGETS[tier],
    // Past 2x, extra pixels cost fill rate and nobody can see them on a phone.
    maxPixelRatio: tier === 'low' ? 1.5 : 2,
    touch, hover, reducedMotion, saveData, browser, os, adapter,
  };
}

/** The software-adapter flag has lived in two places across browser versions. */
function isFallbackAdapter(adapter: GPUAdapter | null): boolean {
  const a = adapter as { isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean } } | null;
  return !!(a?.isFallbackAdapter ?? a?.info?.isFallbackAdapter);
}

/**
 * One calm sentence about why the full experience is not running, and one
 * about what to do. No error codes, no blame.
 */
export function explainUnsupported(
  cap: Pick<Capability, 'status' | 'browser' | 'os'>,
): { reason: string; action: string } {
  if (cap.status === 'insecure-context') {
    return {
      reason: 'This page was loaded without a secure connection.',
      action: 'Open it over https to see the full world.',
    };
  }
  if (cap.status === 'no-adapter' || cap.status === 'device-failed') {
    return {
      reason: 'Your browser supports WebGPU, but could not reach the graphics card.',
      action: 'Turning on hardware acceleration in browser settings usually fixes this.',
    };
  }
  if (cap.os === 'ios') {
    return {
      reason: 'This version of iOS does not have WebGPU yet.',
      action: 'Updating to iOS 26 or later unlocks the full world.',
    };
  }
  if (cap.browser === 'safari') {
    return {
      reason: 'This version of Safari does not have WebGPU yet.',
      action: 'Safari 26 or later, or a current Chrome or Edge, shows the full world.',
    };
  }
  if (cap.browser === 'firefox') {
    return {
      reason: 'WebGPU is not switched on in this Firefox.',
      action: 'A current Firefox on Windows or macOS, or Chrome or Edge, shows the full world.',
    };
  }
  if (cap.os === 'linux') {
    return {
      reason: 'WebGPU is not enabled by default in this browser on Linux.',
      action: 'A recent Chrome with Vulkan enabled shows the full world.',
    };
  }
  return {
    reason: 'This browser does not have WebGPU.',
    action: 'A current Chrome, Edge or Safari shows the full world.',
  };
}
