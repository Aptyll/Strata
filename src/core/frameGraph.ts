import { PASS_ORDER, type FrameContext, type GpuContext, type Pass } from "./contracts";

/**
 * Runs passes stage by stage in PASS_ORDER and owns the HDR target that
 * rasterize passes add into and the tonemap pass reads from.
 */
export class FrameGraph {
  readonly passes: Pass[] = [];
  width = 0;
  height = 0;
  private hdrTexture: GPUTexture | null = null;
  private hdrView: GPUTextureView | null = null;

  constructor(private gpu: GpuContext) {}

  add(...passes: Pass[]): void {
    for (const p of passes) {
      if (this.passes.some((q) => q.name === p.name)) throw new Error(`Duplicate pass name "${p.name}"`);
      this.passes.push(p);
      if (this.hdrTexture) p.resize?.(this.gpu, this.width, this.height);
    }
    // Stable sort: stage order first, registration order within a stage.
    this.passes.sort((a, b) => PASS_ORDER.indexOf(a.stage) - PASS_ORDER.indexOf(b.stage));
  }

  /** Match the drawing buffer to the canvas' CSS size. Call once per frame. */
  resize(maxPixelRatio = 2): void {
    const { canvas, device } = this.gpu;
    const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    const max = device.limits.maxTextureDimension2D;
    const w = Math.max(1, Math.min(max, Math.round(canvas.clientWidth * dpr)));
    const h = Math.max(1, Math.min(max, Math.round(canvas.clientHeight * dpr)));
    if (w === this.width && h === this.height && this.hdrTexture) return;
    canvas.width = this.width = w;
    canvas.height = this.height = h;
    this.hdrTexture?.destroy();
    this.hdrTexture = device.createTexture({
      label: "hdr",
      size: [w, h],
      format: this.gpu.hdrFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.hdrView = this.hdrTexture.createView();
    for (const p of this.passes) p.resize?.(this.gpu, w, h);
  }

  /** Encode and submit one frame. */
  run(frame: Omit<FrameContext, "gpu" | "encoder" | "width" | "height" | "hdrView" | "hdrTexture" | "canvasView">): void {
    if (!this.hdrTexture || !this.hdrView) return;
    const { device, context } = this.gpu;
    const encoder = device.createCommandEncoder();
    const ctx: FrameContext = {
      ...frame,
      gpu: this.gpu,
      encoder,
      width: this.width,
      height: this.height,
      hdrTexture: this.hdrTexture,
      hdrView: this.hdrView,
      canvasView: context.getCurrentTexture().createView(),
    };
    for (const pass of this.passes) {
      if (pass.enabled !== false) pass.execute(ctx);
    }
    device.queue.submit([encoder.finish()]);
  }
}
