/**
 * The world the app is showing: the current Scene, the planes built from it,
 * and the particle total across them.
 *
 * Loading a scene rebuilds every plane on the GPU, points the camera rig at
 * the new planes, and moves the camera only when the scene brings a camera
 * of its own. A scene that came from getScene() (a dice roll, a param edit,
 * a new particle count) keeps the camera exactly where it is, drift and
 * inertia included. That check is intentional; keep it.
 *
 * With ?world the opening scene has no planes: the endless world streams
 * them in through addPlane and removePlane (src/world/driver.ts).
 */
import { behaviors, getBehavior } from "../behaviors";
import type { PlaneDesc, PlaneInstance, Scene } from "../core/contracts";
import type { DepthSpritePass } from "../depth";
import type { Simulation } from "../sim/simulation";
import { planeTargetFromDesc, poseFromState, type EngineCamera } from "../ux/camera";
import { openingCamera, type StreamingWorld } from "../world";
import { scatterLayout, scatterRadius } from "../world/layout";
import type { AppOptions } from "./options";

type LayoutOptions = Pick<AppOptions, "seed" | "behaviors">;

/** A generated scene: sheets scattered through a ball, camera outside it looking in. */
export function buildScene(options: LayoutOptions, particles: number, planes: number, brightness: number): Scene {
  const seed = options.seed;
  const ids = options.behaviors ?? behaviors.map((b) => b.id);
  ids.forEach(getBehavior); // fail early on a typo
  return {
    version: 1,
    seed,
    planes: scatterLayout({ planes, totalParticles: particles, behaviorIds: ids, seed }),
    camera: { target: [0, 0, 0], yaw: 0.6, pitch: -0.35, distance: 2.2 * scatterRadius(planes), fovY: (50 * Math.PI) / 180 },
    render: { brightness },
  };
}

/** The scene the app opens on. With ?world it is empty, and the camera opens on the nearest streamed structure. */
function openingScene(options: AppOptions): Scene {
  const scene = buildScene(options, options.particles, options.planes, options.brightness);
  if (options.world === null) return scene;
  return { ...scene, planes: [], camera: openingCamera({ seed: options.world }, scene.camera.fovY) };
}

export interface SceneHost {
  /** The scene the world was last loaded from. Its render settings are live (setRender writes them). */
  readonly current: Scene;
  /** Particle capacity of every live plane, streamed ones included. */
  readonly total: number;
  /** Sheets in the generated layout. The "planes" setting changes it, then calls rebuild(). */
  planeCount: number;
  /** The streamed world, when ?world is on. Loading a scene clears its planes first. */
  streaming: StreamingWorld | null;
  loadScene(next: Scene): void;
  /** The current scene with the live camera, for code that edits and reloads it. */
  getScene(): Scene;
  /** Rebuild the layout for the current particle total and plane count, keeping camera and brightness. */
  rebuild(): void;
  addPlane(desc: PlaneDesc): PlaneInstance;
  removePlane(plane: PlaneInstance): void;
}

export interface SceneHostDeps {
  sim: Simulation;
  camera: EngineCamera;
  depthSprites: DepthSpritePass | undefined;
  options: AppOptions;
}

/** Creates the host and loads the opening scene. */
export function createSceneHost({ sim, camera, depthSprites, options }: SceneHostDeps): SceneHost {
  let scene = openingScene(options);
  let total = 0;
  /** Camera of the last scene handed out by getScene, to tell "same camera" from "move the camera". */
  let handedOut = "";
  /**
   * The camera can focus, pick and step through every live plane (G, double click, comma and period),
   * streamed ones too: a streamed world's scene lists none of them.
   */
  const followPlanes = () => {
    const targets = sim.planes.map((p) => planeTargetFromDesc(p.desc));
    camera.rig.setPlanes(targets);
    return targets;
  };

  const host: SceneHost = {
    get current() {
      return scene;
    },
    get total() {
      return total;
    },
    planeCount: options.planes,
    streaming: null,

    loadScene(next) {
      host.streaming?.clear(); // setPlanes below destroys every plane, streamed ones included
      scene = next;
      sim.setPlanes(scene.planes);
      total = sim.planes.reduce((n, p) => n + p.capacity, 0);
      const targets = followPlanes();
      // A generated world has a fixed middle for the camera to stay near; a streamed one does not.
      camera.rig.limitTo(scene.planes.length > 0 ? targets : []);
      depthSprites?.fitWorld(sim.planes);
      if (JSON.stringify(scene.camera) !== handedOut) {
        camera.state = structuredClone(scene.camera);
        camera.rig.setHome(poseFromState(scene.camera));
      }
    },

    getScene() {
      const cam = camera.snapshot();
      handedOut = JSON.stringify(cam);
      return { ...scene, camera: cam };
    },

    rebuild() {
      const keep = host.getScene();
      const fresh = buildScene(options, total, host.planeCount, keep.render.brightness);
      host.loadScene(fresh.planes.length === keep.planes.length ? { ...fresh, camera: keep.camera } : fresh);
    },

    addPlane(desc) {
      const plane = sim.addPlane(desc);
      total += plane.capacity;
      followPlanes();
      return plane;
    },

    removePlane(plane) {
      if (!sim.planes.includes(plane)) return;
      total -= plane.capacity;
      sim.removePlane(plane);
      followPlanes();
    },
  };

  host.loadScene(scene);
  return host;
}
