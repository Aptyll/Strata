import type { CameraController, CameraState, Mat4, Vec3 } from "./core/contracts";
import { lookAt, multiply, perspective } from "./math";

/**
 * Orbit camera with inertia. Drag to orbit, wheel to zoom, right-drag or
 * shift-drag to pan, WASD/QE to fly the orbit target, space toggles auto-rotate.
 */
export class OrbitCamera implements CameraController {
  state: CameraState = { target: [0, 0, 0], yaw: 0.6, pitch: 0.35, distance: 14, fovY: (50 * Math.PI) / 180 };
  near = 0.01;
  far = 2000;
  autoRotate = true;
  autoRotateSpeed = 0.05;

  private yawVel = 0;
  private pitchVel = 0;
  private keys = new Set<string>();
  private dragging: "orbit" | "pan" | null = null;

  constructor(el: HTMLElement) {
    el.addEventListener("pointerdown", (e) => {
      this.dragging = e.button === 2 || e.shiftKey ? "pan" : "orbit";
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointerup", (e) => {
      this.dragging = null;
      el.releasePointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      if (this.dragging === "orbit") {
        this.yawVel = -e.movementX * 0.005;
        this.pitchVel = e.movementY * 0.005;
        this.state.yaw += this.yawVel;
        this.state.pitch += this.pitchVel;
      } else {
        const k = this.state.distance * 0.0012;
        this.move(-e.movementX * k, e.movementY * k, 0);
      }
    });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.state.distance = clamp(this.state.distance * Math.exp(e.deltaY * 0.001), 0.05, 500);
    }, { passive: false });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") this.autoRotate = !this.autoRotate;
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  update(dt: number): void {
    if (!this.dragging) {
      this.state.yaw += this.yawVel;
      this.state.pitch += this.pitchVel;
      const damp = Math.exp(-dt * 6);
      this.yawVel *= damp;
      this.pitchVel *= damp;
      if (this.autoRotate) this.state.yaw += this.autoRotateSpeed * dt;
    }
    const lim = Math.PI / 2 - 0.001;
    this.state.pitch = clamp(this.state.pitch, -lim, lim);

    const k = this.keys;
    const s = this.state.distance * 0.6 * dt;
    const axis = (pos: string, neg: string) => (k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0);
    const dx = axis("KeyD", "KeyA"), dy = axis("KeyE", "KeyQ"), dz = axis("KeyS", "KeyW");
    if (dx || dy || dz) this.move(dx * s, dy * s, dz * s);
  }

  /** Move the orbit target in camera space (right, up, back). */
  private move(right: number, up: number, back: number): void {
    const cy = Math.cos(this.state.yaw), sy = Math.sin(this.state.yaw);
    const cp = Math.cos(this.state.pitch), sp = Math.sin(this.state.pitch);
    const r: Vec3 = [cy, 0, -sy];
    const b: Vec3 = [cp * sy, sp, cp * cy];
    const u: Vec3 = [-sp * sy, cp, -sp * cy];
    for (let i = 0; i < 3; i++) this.state.target[i] += r[i] * right + u[i] * up + b[i] * back;
  }

  eye(): Vec3 {
    const cp = Math.cos(this.state.pitch);
    return [
      this.state.target[0] + this.state.distance * cp * Math.sin(this.state.yaw),
      this.state.target[1] + this.state.distance * Math.sin(this.state.pitch),
      this.state.target[2] + this.state.distance * cp * Math.cos(this.state.yaw),
    ];
  }

  viewProjection(aspect: number): Mat4 {
    const view = lookAt(this.eye(), this.state.target, [0, 1, 0]);
    return multiply(perspective(this.state.fovY, aspect, this.near, this.far), view);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
