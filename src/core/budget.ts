import type { BudgetInput, BudgetPlaneInfo, CameraController, Mat4, ParticleBudget, PlaneInstance } from "./contracts";

/**
 * Default budget: planes in view run at full capacity, planes fully out of
 * view are paused. Smarter budgets (distance falloff, fps feedback) replace
 * this by implementing ParticleBudget.
 */
export class VisibleOnlyBudget implements ParticleBudget {
  allocate(input: BudgetInput): number[] {
    return input.planes.map((p) => (p.visible ? p.capacity : 0));
  }
}

/** Per-plane facts a ParticleBudget decides from. */
export function measurePlanes(
  planes: readonly PlaneInstance[],
  camera: CameraController,
  viewProj: Mat4,
): BudgetPlaneInfo[] {
  const eye = camera.eye();
  const frustum = frustumPlanes(viewProj);
  const tanHalf = Math.tan(camera.state.fovY / 2);
  return planes.map((plane) => {
    const [x, y, z] = plane.desc.position;
    const radius = Math.hypot(plane.desc.halfSize[0], plane.desc.halfSize[1]);
    const distance = Math.hypot(x - eye[0], y - eye[1], z - eye[2]);
    // Bounding sphere against the six frustum planes (conservative).
    const visible = frustum.every((f) => f[0] * x + f[1] * y + f[2] * z + f[3] >= -radius);
    // Sphere's projected radius as a fraction of the view height, squared.
    const r = radius / Math.max(distance * tanHalf, 1e-6);
    return { capacity: plane.capacity, distance, visible, screenCoverage: Math.min(1, r * r) };
  });
}

/** Normalized inward-facing frustum planes from a column-major view-projection (depth 0..1). */
function frustumPlanes(m: Mat4): number[][] {
  const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const add = (a: number[], b: number[], s: number) => a.map((v, i) => v + s * b[i]);
  return [add(r3, r0, 1), add(r3, r0, -1), add(r3, r1, 1), add(r3, r1, -1), r2, add(r3, r2, -1)].map((p) => {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    return p.map((v) => v / l);
  });
}
