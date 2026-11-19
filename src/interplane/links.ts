/**
 * Which plane edge leads to which neighbour. Pure math, no GPU.
 *
 * Every plane has 4 exits: 0 = +x edge, 1 = -x edge, 2 = +y edge, 3 = -y edge
 * (plane-local axes). A link sends particles that leave through one exit to an
 * edge of another plane.
 */
import type { PlaneDesc, Quat, Vec3 } from "../core/contracts";

export const EDGES = 4;

export interface Link {
  /** Source plane index and the edge (0..3) particles leave through. */
  src: number;
  exit: number;
  /** Destination plane index and the edge (0..3) particles arrive through. */
  dst: number;
  entry: number;
  /** -1 when the along-edge coordinate is mirrored between the two edges. */
  flip: 1 | -1;
  /** World distance between the two edge centres. Sets the flight time. */
  length: number;
}

export interface LinkOptions {
  /** Ignore neighbours whose edge is further away than this. Default Infinity. */
  maxDistance?: number;
  /** How far off-axis a neighbour may be, as the cosine of the angle. Default 0.2. */
  minCos?: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // v + 2w (q x v) + 2 q x (q x v)
  const cx = y * v[2] - z * v[1];
  const cy = z * v[0] - x * v[2];
  const cz = x * v[1] - y * v[0];
  return [
    v[0] + 2 * (w * cx + y * cz - z * cy),
    v[1] + 2 * (w * cy + z * cx - x * cz),
    v[2] + 2 * (w * cz + x * cy - y * cx),
  ];
}

/** World-space axes of a plane: u and v are unit length. */
export function planeAxes(p: PlaneDesc): { u: Vec3; v: Vec3 } {
  return { u: rotate(p.rotation, [1, 0, 0]), v: rotate(p.rotation, [0, 1, 0]) };
}

/**
 * Plane-local to world, column-major, with the half size baked in as scale.
 * Local z maps to the plane normal at unit scale.
 */
export function planeModel(p: PlaneDesc, out: Float32Array, offset = 0): void {
  const { u, v } = planeAxes(p);
  const n = rotate(p.rotation, [0, 0, 1]);
  const [hx, hy] = p.halfSize;
  out.set([u[0] * hx, u[1] * hx, u[2] * hx, 0, v[0] * hy, v[1] * hy, v[2] * hy, 0, n[0], n[1], n[2], 0, p.position[0], p.position[1], p.position[2], 1], offset);
}

const SIGN = [1, -1, 1, -1];

interface Edge {
  centre: Vec3;
  /** Unit outward direction in world space. */
  out: Vec3;
  /** Unit direction of increasing along-edge coordinate. */
  tangent: Vec3;
}

function edgesOf(p: PlaneDesc): Edge[] {
  const { u, v } = planeAxes(p);
  const edges: Edge[] = [];
  for (let e = 0; e < EDGES; e++) {
    const axis = e < 2 ? u : v;
    const half = p.halfSize[e < 2 ? 0 : 1] * SIGN[e];
    edges.push({
      centre: [p.position[0] + axis[0] * half, p.position[1] + axis[1] * half, p.position[2] + axis[2] * half],
      out: [axis[0] * SIGN[e], axis[1] * SIGN[e], axis[2] * SIGN[e]],
      tangent: e < 2 ? v : u,
    });
  }
  return edges;
}

/**
 * For every edge of every plane, pick the nearest edge of another plane that
 * lies roughly in front of it. Edges with nothing in front get no link, and
 * particles there are left alone.
 */
export function buildLinks(planes: readonly PlaneDesc[], opts: LinkOptions = {}): Link[] {
  const { maxDistance = Infinity, minCos = 0.2 } = opts;
  const edges = planes.map(edgesOf);
  const links: Link[] = [];
  for (let i = 0; i < planes.length; i++) {
    for (let e = 0; e < EDGES; e++) {
      const from = edges[i][e];
      let best: Link | null = null;
      let bestScore = Infinity;
      for (let j = 0; j < planes.length; j++) {
        if (j === i) continue;
        for (let k = 0; k < EDGES; k++) {
          const to = edges[j][k];
          const d = sub(to.centre, from.centre);
          const dist = Math.hypot(d[0], d[1], d[2]);
          if (dist > maxDistance) continue;
          const cos = dist > 1e-6 ? dot(d, from.out) / dist : 1;
          if (cos < minCos) continue;
          // Prefer close and straight ahead.
          const score = dist / (0.25 + cos);
          if (score >= bestScore) continue;
          bestScore = score;
          best = { src: i, exit: e, dst: j, entry: k, flip: dot(from.tangent, to.tangent) < 0 ? -1 : 1, length: Math.max(dist, 1e-3) };
        }
      }
      if (best) links.push(best);
    }
  }
  return links;
}
