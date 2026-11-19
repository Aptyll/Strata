// CPU side of the DepthParams uniform. Layout must match depth.wgsl.ts.

export const DEPTH_PARAMS_FLOATS = 20;
export const DEPTH_PARAMS_BYTES = DEPTH_PARAMS_FLOATS * 4;

export interface DepthSettings {
  /** Cue switches. A disabled cue is packed as its neutral value. */
  fog: boolean;
  dof: boolean;
  atmosphere: boolean;
  fogDensity: number;
  fogPower: number;
  fogStart: number;
  nearFade: number;
  focusDist: number;
  aperture: number;
  maxCocPx: number;
  focusRange: number;
  baseSize: number;
  sizeAttenuation: number;
  minPx: number;
  brightness: number;
  distDim: number;
  refDist: number;
  bokehEdge: number;
  cullIntensity: number;
}

export interface DepthCameraInfo {
  /** Render target height in physical px. */
  viewportH: number;
  /** projection[1][1], which is 1 / tan(fovY / 2). */
  projScaleY: number;
}

export const DEPTH_DEFAULTS: Readonly<DepthSettings> = Object.freeze({
  // which cues are on. A disabled cue is packed as its neutral value, so the
  // shader has no branches and toggling costs nothing.
  fog: true,
  dof: true,
  atmosphere: true,

  fogDensity: 1 / 200,
  fogPower: 2,
  fogStart: 0,
  nearFade: 4,

  focusDist: 20,
  aperture: 7,
  maxCocPx: 40,
  focusRange: 1,

  baseSize: 0.035,
  sizeAttenuation: 1,
  minPx: 0.6,
  brightness: 1,

  distDim: 0,
  refDist: 20,

  bokehEdge: 0.25,
  cullIntensity: 1 / 2048,
});

export interface DepthParams extends DepthSettings {}
export class DepthParams {
  constructor(overrides: Partial<DepthSettings> = {}) {
    Object.assign(this, DEPTH_DEFAULTS, overrides);
  }

  /** Pack into a Float32Array ready for device.queue.writeBuffer. */
  pack(camera: DepthCameraInfo, out: Float32Array = new Float32Array(DEPTH_PARAMS_FLOATS)): Float32Array {
    const fog = this.fog;
    const dof = this.dof;
    const atm = this.atmosphere;
    out[0] = fog ? this.fogDensity : 0;
    out[1] = this.fogPower;
    out[2] = this.fogStart;
    out[3] = this.nearFade;
    out[4] = this.focusDist;
    out[5] = dof ? this.aperture : 0;
    out[6] = this.maxCocPx;
    out[7] = this.focusRange;
    out[8] = this.baseSize;
    out[9] = atm ? this.sizeAttenuation : 0;
    out[10] = this.minPx;
    out[11] = this.brightness;
    out[12] = camera.viewportH;
    out[13] = camera.projScaleY;
    out[14] = atm ? this.distDim : 0;
    out[15] = this.refDist;
    out[16] = dof ? this.bokehEdge : 0;
    out[17] = this.cullIntensity;
    out[18] = 0;
    out[19] = 0;
    return out;
  }

  /** Fog transmittance at a distance. Mirrors depth_fog in WGSL. */
  fogAt(dist: number): number {
    if (!this.fog || this.fogDensity <= 0) return 1;
    const d = Math.max(dist - this.fogStart, 0) * this.fogDensity;
    return Math.exp(-Math.pow(d, Math.max(this.fogPower, 0.001)));
  }

  /** Circle of confusion radius in px. Mirrors depth_coc_px in WGSL. */
  cocAt(viewZ: number): number {
    if (!this.dof) return 0;
    const off = Math.max(Math.abs(viewZ - this.focusDist) - this.focusRange, 0);
    return Math.min((this.aperture * off) / Math.max(viewZ, 1e-4), this.maxCocPx);
  }

  /**
   * Distance beyond which fog alone has dimmed everything below `threshold`.
   * An engine can skip whole planes farther than this. Infinity if fog is off.
   */
  fogCullDistance(threshold: number = this.cullIntensity / Math.max(this.brightness, 1e-9)): number {
    if (!this.fog || this.fogDensity <= 0) return Infinity;
    const t = Math.min(Math.max(threshold, 1e-12), 0.999999);
    const d = Math.pow(-Math.log(t), 1 / Math.max(this.fogPower, 0.001));
    return this.fogStart + d / this.fogDensity;
  }
}
