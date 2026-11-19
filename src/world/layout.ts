import type { PlaneDesc, Vec3 } from "../core/contracts";
import { quatFromAxisAngle, seededRandom } from "../math";

export interface LayoutOptions {
  planes: number;
  totalParticles: number;
  /** Behavior ids to cycle through. */
  behaviorIds: readonly string[];
  seed?: number;
}

/** Radius of the ball that scatterLayout fills. Grows with the number of sheets. */
export const scatterRadius = (planes: number) => 1.6 * Math.cbrt(planes) + 1;

/**
 * Scatter sheets through a ball with random orientations, cycling through the
 * given behaviors. The ball grows with the number of sheets so the world is
 * always bigger than what one camera view can hold.
 */
export function scatterLayout(opts: LayoutOptions): PlaneDesc[] {
  const random = seededRandom(opts.seed ?? 1);
  const radius = scatterRadius(opts.planes);
  const perPlane = Math.max(1, Math.floor(opts.totalParticles / opts.planes));
  const out: PlaneDesc[] = [];
  for (let i = 0; i < opts.planes; i++) {
    const dir = randomUnit(random);
    const r = radius * Math.cbrt(random());
    const size = 1.2 + random() * 1.3;
    out.push({
      id: `plane-${i}`,
      position: [dir[0] * r, dir[1] * r * 0.6, dir[2] * r],
      rotation: quatFromAxisAngle(randomUnit(random), random() * Math.PI * 2),
      halfSize: [size, size * (0.7 + random() * 0.6)],
      behaviorId: opts.behaviorIds[i % opts.behaviorIds.length],
      particleCount: perPlane,
      seed: random(),
    });
  }
  return out;
}

function randomUnit(random: () => number): Vec3 {
  const z = random() * 2 - 1;
  const a = random() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), z, s * Math.sin(a)];
}
