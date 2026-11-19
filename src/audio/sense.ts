/** Reading a SoundFrame from the running engine, through the shared contracts only. */
import { measurePlanes } from "../core/budget";
import type { CameraController, PlaneInstance } from "../core/contracts";
import type { SoundFrame } from "./types";

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

/**
 * 0..1 from particles per covered pixel, on a log scale: 0.1 per pixel (a
 * sparse dusting) is 0, 10 000 per pixel (far past saturation) is 1.
 */
export function densityOf(particlesPerPixel: number): number {
  return particlesPerPixel > 0 ? clamp01((Math.log10(particlesPerPixel) + 1) / 5) : 0;
}

/**
 * What the music needs from one frame: particles drawn, how much of the
 * screen the visible sheets cover and how dense they look, and the camera.
 * One pass over the planes, the same measurement the particle budget makes.
 */
export function senseScene(
  planes: readonly PlaneInstance[],
  camera: CameraController,
  width: number,
  height: number,
): SoundFrame {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const infos = measurePlanes(planes, camera, camera.viewProjection(w / h));
  let cover = 0;
  let visible = 0;
  let total = 0;
  for (let i = 0; i < planes.length; i++) {
    const n = planes[i].activeCount;
    total += n;
    if (infos[i].visible) {
      cover += infos[i].screenCoverage;
      visible += n;
    }
  }
  const fill = Math.min(1, cover);
  const s = camera.state;
  return {
    particles: total,
    fill,
    density: densityOf(visible / Math.max(1, fill * w * h)),
    yaw: s.yaw,
    pitch: s.pitch,
    distance: s.distance,
  };
}
