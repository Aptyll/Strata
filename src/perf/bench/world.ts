/**
 * Benchmark world: stacks of slightly tilted "paper" planes laid out on a grid
 * that is wider than the camera view, so culling and LOD have work to do.
 */

import { mat4PlaneModel, type PerfEngine } from '../index';

export interface BenchWorld {
  /** Half extent of the world, for camera framing. */
  radius: number;
  planes: number;
  particles: number;
}

const STACK = 8;
const STACK_SPACING = 0.14;
const GRID_SPACING = 1.3;

function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function buildWorld(engine: PerfEngine, totalParticles: number, planeCount: number): BenchWorld {
  const perPlane = Math.max(1, Math.min(engine.pool.maxRange, Math.floor(totalParticles / planeCount)));
  const stacks = Math.ceil(planeCount / STACK);
  const cols = Math.ceil(Math.sqrt(stacks));
  const rows = Math.ceil(stacks / cols);
  const model = new Float32Array(16);
  const names = engine.behaviors.map((b) => b.name);

  for (let i = 0; i < planeCount; i++) {
    const stack = Math.floor(i / STACK);
    const layer = i % STACK;
    const layersHere = Math.min(STACK, planeCount - stack * STACK);
    const gx = (stack % cols) - (cols - 1) / 2;
    const gy = Math.floor(stack / cols) - (rows - 1) / 2;
    const z = (layer - (layersHere - 1) / 2) * STACK_SPACING;
    mat4PlaneModel(
      model,
      [gx * GRID_SPACING, gy * GRID_SPACING, z],
      1,
      (hash01(i * 3 + 1) - 0.5) * 0.3,
      (hash01(i * 3 + 2) - 0.5) * 0.3,
      (hash01(i * 3 + 3) - 0.5) * 0.6,
    );
    engine.addPlane({ count: perPlane, model, behavior: names[i % names.length] });
  }

  return {
    radius: Math.max(0.8, (Math.max(cols, rows) * GRID_SPACING) / 2),
    planes: planeCount,
    particles: perPlane * planeCount,
  };
}
