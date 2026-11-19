/**
 * Per-plane frustum culling and level of detail, on the CPU.
 *
 * A plane is the square [-1, 1]^2 at z = 0 in its local space (the shared
 * engine's sheet convention; the model matrix carries the half size). Given
 * its model-view-projection matrix we classify it once per frame:
 *
 *  - visible:      false when all four corners are outside one frustum plane.
 *                  Culled planes cost zero GPU work (no dispatch at all).
 *  - fraction:     share of the plane's particles worth drawing. Particles are
 *                  stored in random order, so any prefix of the range is an
 *                  unbiased sample. We draw just enough to reach a target
 *                  density of particles per projected pixel and scale their
 *                  brightness by 1 / fraction so the image keeps its energy.
 *  - simInterval:  simulate every Nth frame (with the accumulated dt).
 */

export interface LodSettings {
  /** Skip planes whose quad is entirely outside the frustum. */
  culling: boolean;
  /** Enable density-based particle LOD and rate LOD. */
  lod: boolean;
  /** Target particles per projected pixel before LOD starts dropping particles. */
  pixelDensity: number;
  /** Never draw less than this share of a visible plane. */
  minFraction: number;
  /** Upper bound for the simulation interval of visible planes (frames). */
  maxSimInterval: number;
  /** Simulation interval for culled planes (frames). 0 freezes them. */
  culledSimInterval: number;
  /**
   * true: a visible plane simulates all of its particles (at its LOD rate).
   * false: only the drawn prefix is simulated, the rest goes stale until the
   * plane comes closer. Cheaper, but stale particles can pop for behaviors
   * whose field changes over time.
   */
  simulateHidden: boolean;
}

export const DEFAULT_LOD: LodSettings = {
  culling: true,
  lod: true,
  pixelDensity: 4,
  minFraction: 1 / 64,
  maxSimInterval: 4,
  culledSimInterval: 8,
  simulateHidden: true,
};

export interface PlaneClass {
  visible: boolean;
  fraction: number;
  simInterval: number;
  /** Projected area of the whole quad in pixels (Infinity when it crosses the camera plane). */
  areaPx: number;
}

const CX = [-1, 1, 1, -1];
const CY = [-1, -1, 1, 1];
const sx = new Float64Array(4);
const sy = new Float64Array(4);

export function classifyPlane(
  mvp: ArrayLike<number>,
  count: number,
  viewportWidth: number,
  viewportHeight: number,
  s: LodSettings,
  out: PlaneClass = { visible: true, fraction: 1, simInterval: 1, areaPx: 0 },
): PlaneClass {
  let andCode = 0x3f;
  let allInFront = true;
  for (let i = 0; i < 4; i++) {
    const x = CX[i], y = CY[i];
    const cx = mvp[0] * x + mvp[4] * y + mvp[12];
    const cy = mvp[1] * x + mvp[5] * y + mvp[13];
    const cz = mvp[2] * x + mvp[6] * y + mvp[14];
    const cw = mvp[3] * x + mvp[7] * y + mvp[15];
    let code = 0;
    if (cx < -cw) code |= 1;
    if (cx > cw) code |= 2;
    if (cy < -cw) code |= 4;
    if (cy > cw) code |= 8;
    if (cz < 0) code |= 16;
    if (cz > cw) code |= 32;
    andCode &= code;
    if (cw > 1e-6) {
      sx[i] = (cx / cw) * 0.5 * viewportWidth;
      sy[i] = (cy / cw) * 0.5 * viewportHeight;
    } else {
      allInFront = false;
    }
  }

  out.visible = !(s.culling && andCode !== 0);
  out.fraction = 1;
  out.simInterval = 1;
  out.areaPx = Infinity;
  if (!out.visible) {
    out.fraction = 0;
    out.simInterval = s.culledSimInterval;
    return out;
  }
  if (allInFront) {
    // Shoelace area of the whole projected quad. Deliberately not clipped to
    // the viewport: LOD is about particle density per pixel, and density is
    // count / total projected area regardless of how much is on screen.
    let a = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      a += sx[i] * sy[j] - sx[j] * sy[i];
    }
    out.areaPx = Math.abs(a) * 0.5;
  }
  if (s.lod && out.areaPx !== Infinity) {
    const f = (s.pixelDensity * out.areaPx) / Math.max(1, count);
    out.fraction = Math.min(1, Math.max(s.minFraction, f));
    const interval = out.fraction >= 0.5 ? 1 : out.fraction >= 0.25 ? 2 : 4;
    out.simInterval = Math.max(1, Math.min(s.maxSimInterval, interval));
  }
  return out;
}
