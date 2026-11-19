/** Tiny text overlay: particle count, how many are in view, plane count and smoothed fps. */
export class Overlay {
  private frames = 0;
  private last = performance.now();
  fps = 0;

  constructor(private el: HTMLElement) {}

  message(text: string): void {
    this.el.textContent = text;
  }

  tick(particles: number, active: number, planes: number): void {
    this.frames++;
    const now = performance.now();
    if (now - this.last < 250) return;
    this.fps = (this.frames * 1000) / (now - this.last);
    this.frames = 0;
    this.last = now;
    const n = (v: number) => v.toLocaleString("en-US");
    const inView = active < particles ? `\n${n(active)} in view` : "";
    this.el.textContent = `${n(particles)} particles${inView}\n${planes} planes\n${this.fps.toFixed(0)} fps`;
  }
}
