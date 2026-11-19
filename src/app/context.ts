/**
 * Builds the AppContext (src/core/contracts.ts): everything UI and feature
 * code may touch in the running app. Each member just forwards to the part
 * that owns it, so this file is a map of who does what:
 *
 *   planes, updatePlane, setPlaneBehavior   the simulation (src/sim)
 *   getScene, loadScene, addPlane, removePlane, setRender   the scene host (./scene.ts)
 *   stats().fps   the frame loop's meter (./loop.ts)
 */
import { behaviors } from "../behaviors";
import type { AppContext, CameraController, GpuContext, Pass } from "../core/contracts";
import type { Simulation } from "../sim/simulation";
import type { FpsMeter } from "./loop";
import type { SceneHost } from "./scene";

export interface AppContextParts {
  gpu: GpuContext;
  camera: CameraController;
  sim: Simulation;
  passes: readonly Pass[];
  scenes: SceneHost;
  fps: FpsMeter;
}

export function createAppContext({ gpu, camera, sim, passes, scenes, fps }: AppContextParts): AppContext {
  return {
    gpu,
    camera,
    behaviors,
    passes,
    get planes() {
      return sim.planes;
    },
    getScene: () => scenes.getScene(),
    loadScene: (scene) => scenes.loadScene(scene),
    addPlane: (desc) => scenes.addPlane(desc),
    removePlane: (plane) => scenes.removePlane(plane),
    updatePlane: (plane) => sim.updatePlane(plane),
    setPlaneBehavior: (plane, change) => sim.setBehavior(plane, change),
    setRender: (patch) => void Object.assign(scenes.current.render, patch),
    stats: () => ({
      fps: fps.value,
      // Stepped this frame: a paused sheet (asleep in ?world) is drawn but not stepped, so it does not count.
      particles: sim.planes.reduce((n, p) => n + (p.paused ? 0 : p.activeCount), 0),
      planes: sim.planes.length,
    }),
  };
}
