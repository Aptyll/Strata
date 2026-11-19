// Injected before any page script (Playwright addInitScript).
// 1. Time is ours: requestAnimationFrame callbacks run only on window.__step(ms),
//    and performance.now advances by exactly that much, so every frame is a fixed dt.
// 2. Headless WebGPU canvases cannot present (the device is lost), so the canvas
//    context hands out an ordinary texture that window.__grab() reads back.
(() => {
  let now = 0;
  performance.now = () => now;
  let queue = [];
  window.requestAnimationFrame = (cb) => (queue.push(cb), queue.length);
  window.cancelAnimationFrame = () => {};
  window.__step = (ms) => {
    now += ms;
    const run = queue;
    queue = [];
    for (const cb of run) cb(now);
  };
  let ctx = null;
  GPUCanvasContext.prototype.configure = function (cfg) {
    this.__cfg = cfg;
    ctx = this;
  };
  GPUCanvasContext.prototype.unconfigure = function () {};
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    const c = this.canvas, cfg = this.__cfg;
    if (!this.__tex || this.__tex.width !== c.width || this.__tex.height !== c.height) {
      this.__tex?.destroy();
      this.__tex = cfg.device.createTexture({
        size: [c.width, c.height],
        format: cfg.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | (cfg.usage ?? 0),
      });
    }
    return this.__tex;
  };
  // Returns { width, height, format, b64 } with tightly packed 4-byte pixels.
  window.__grab = async () => {
    const tex = ctx?.__tex;
    if (!tex) return null;
    const device = ctx.__cfg.device;
    const { width, height } = tex;
    const stride = Math.ceil((width * 4) / 256) * 256;
    const buf = device.createBuffer({ size: stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: stride, rowsPerImage: height }, [width, height]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(src.subarray(y * stride, y * stride + width * 4), y * width * 4);
    buf.unmap();
    buf.destroy();
    let s = '';
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
    return { width, height, format: tex.format, b64: btoa(s) };
  };
})();
