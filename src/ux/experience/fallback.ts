// What people see when WebGPU is not available.
//
// Not an error page. The same black void, the same opening, one real plane of
// particles simulated on the CPU and drawn with Canvas 2D, and two quiet lines
// of text saying what they are looking at and how to see the rest. Someone on
// an old phone should still get something worth thirty seconds, and should
// leave knowing there is more.

import { TYPE, installTokens } from '../design';
import { type Capability, explainUnsupported } from './capability';
import { ForceBrush, brushForce } from './force-brush';
import type { PlaneHit } from './pointer-ray';
import { bindGestures } from './gestures';
import { introState } from './intro';

// Styled from the design tokens (docs/ux/design.md). The note is spoken to the person, so it takes
// the voice: a caption for the lede, the body role for the sentences, and the shared button. It sits
// over the particles, so it has the halo. It arrives unasked, so it fades in slowly.
const STYLE = `
.strata-fallback{position:absolute;inset:0;background:var(--st-void);overflow:hidden}
.strata-fallback canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
.strata-fallback-note{position:absolute;left:0;right:0;bottom:calc(var(--st-edge-bottom) + var(--st-space-6));
padding:0 var(--st-edge);text-align:center;text-shadow:var(--st-halo);
opacity:0;transition:opacity var(--st-slow) var(--st-ease-soft);pointer-events:none}
.strata-fallback-note[data-on="1"]{opacity:1}
.strata-fallback-note p{margin:0 auto;max-width:34em;text-wrap:balance}
.strata-fallback-note .lede{${TYPE.caption}color:var(--st-dim);text-indent:var(--st-track-wide);margin-bottom:var(--st-space-3)}
.strata-fallback-note .body{${TYPE.body}}
.strata-fallback-note button{pointer-events:auto;margin-top:var(--st-space-4)}
`;

export interface FallbackOptions {
  /** Particles in the single CPU plane. */
  particles?: number;
  /** Particles the full world opens with, for the caption. Pass the app's real number. */
  fullCount?: number;
  /** Sheets the full world opens with, for the caption. */
  sheets?: number;
  /** Link offered for opening on another device. Defaults to the current page. */
  url?: string;
}

/** @param container a positioned element to fill */
export function mountFallback(
  container: HTMLElement,
  cap: Pick<Capability, 'status' | 'browser' | 'os' | 'touch' | 'reducedMotion' | 'maxPixelRatio'>,
  opts: FallbackOptions = {},
): { dispose: () => void; canvas: HTMLCanvasElement } {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? window;
  const count = opts.particles ?? (cap.touch ? 9000 : 24000);
  // The caption only states numbers it was given: what the app would have opened with on this device.
  const fullCount = opts.fullCount;
  const million = (n: number) => `${Math.round(n / 1e5) / 10} million`;
  const full =
    fullCount && opts.sheets
      ? `The full world opens on ${opts.sheets} sheets and ${fullCount >= 1e6 ? million(fullCount) : fullCount.toLocaleString('en-US')} particles, and the count can be raised from there.`
      : 'The full world is many sheets and millions of particles.';

  installTokens(doc);
  if (!doc.getElementById('strata-fallback-style')) {
    const style = doc.createElement('style');
    style.id = 'strata-fallback-style';
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }

  const root = doc.createElement('div');
  root.className = 'strata-fallback';
  const canvas = doc.createElement('canvas');
  canvas.setAttribute('aria-label', 'A field of white particles drifting on black');
  canvas.setAttribute('role', 'img');
  root.appendChild(canvas);

  const { reason, action } = explainUnsupported(cap);
  const note = doc.createElement('div');
  note.className = 'strata-fallback-note';
  const lede = doc.createElement('p');
  lede.className = 'lede';
  lede.textContent = `One sheet. ${count.toLocaleString('en-US')} particles.`;
  const body = doc.createElement('p');
  body.className = 'body';
  body.textContent = `${full} ${reason} ${action}`;
  note.append(lede, body);

  // Most people who land here are on a phone and will want to open the link
  // on another machine. Make that one tap.
  const url = opts.url ?? win.location.href;
  const canShare = typeof win.navigator.share === 'function';
  const canCopy = !!win.navigator.clipboard?.writeText;
  if (canShare || canCopy) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'st-button';
    btn.textContent = canShare ? 'Send link to another device' : 'Copy link';
    btn.addEventListener('click', async () => {
      try {
        if (canShare) await win.navigator.share({ title: doc.title, url });
        else {
          await win.navigator.clipboard.writeText(url);
          btn.textContent = 'Link copied';
        }
      } catch { /* share sheet dismissed */ }
    });
    note.appendChild(btn);
  }
  root.appendChild(note);
  container.appendChild(root);

  // --- simulation: one plane, coordinates in -1..1 ---
  const px = new Float32Array(count);
  const py = new Float32Array(count);
  const vx = new Float32Array(count);
  const vy = new Float32Array(count);
  const birth = new Float32Array(count); // radius at which the bloom reveals it
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 1.1;
    px[i] = Math.cos(a) * r;
    py[i] = Math.sin(a) * r;
    birth[i] = r;
  }

  const ctx = canvas.getContext('2d', { alpha: false })!;
  let w = 0, h = 0, dpr = 1, scale = 1;
  let image!: ImageData;
  let pixels!: Uint32Array;
  function resize(): void {
    dpr = Math.min(win.devicePixelRatio || 1, cap.maxPixelRatio ?? 1.5);
    w = Math.max(1, Math.round(root.clientWidth * dpr));
    h = Math.max(1, Math.round(root.clientHeight * dpr));
    canvas.width = w;
    canvas.height = h;
    image = ctx.createImageData(w, h);
    pixels = new Uint32Array(image.data.buffer);
    // Cover the screen: the sheet is larger than the view, as in the real thing.
    scale = Math.max(w, h) * 0.5;
  }
  resize();
  const ro = new win.ResizeObserver(resize);
  ro.observe(root);

  const brush = new ForceBrush();
  let pointer: PlaneHit | null = null;
  const toPlane = (x: number, y: number): PlaneHit => {
    const r = canvas.getBoundingClientRect();
    return {
      index: 0, t: 1, grip: 1, facing: 1, point: [0, 0, 0],
      u: ((x - r.left) * dpr - w / 2) / scale,
      v: ((y - r.top) * dpr - h / 2) / scale,
    };
  };
  const gestures = bindGestures(canvas, {
    onHover: (x, y) => { pointer = toPlane(x, y); },
    onHoverEnd: () => { pointer = null; brush.leave(); },
    // With one plane and no camera there is nothing to orbit, so a drag
    // simply stirs: the wake follows the finger.
    onOrbit: () => {},
    onHoldStart: (x, y, _id, mode) => { pointer = toPlane(x, y); brush.press(mode); },
    onHoldMove: (x, y) => { pointer = toPlane(x, y); },
    onHoldEnd: () => { brush.release(); },
  });
  const trackDrag = (e: PointerEvent) => { if (e.buttons || e.pointerType === 'touch') pointer = toPlane(e.clientX, e.clientY); };
  canvas.addEventListener('pointermove', trackDrag);

  const variant = cap.reducedMotion ? 'reduced' : 'full';
  let t = 0, last = 0, raf = 0, running = true, noteShown = false;

  function frame(now: number): void {
    if (!running) return;
    raf = win.requestAnimationFrame(frame);
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    t += dt;
    gestures.tick(now);

    const intro = introState(t, { variant });
    if (!noteShown && t > 7) { note.dataset.on = '1'; noteShown = true; }

    const b = brush.update(dt, pointer, 0.22);
    const forceOn = b.plane >= 0;
    const time = t * 0.12;

    const data = image.data;
    pixels.fill(0xff000000); // opaque black, one pass

    const reveal = intro.heroBloom * 1.6;
    const gain = Math.round(150 * intro.exposure * (dpr > 1.2 ? 1 : 0.8));
    const drag = Math.pow(0.5, dt / 0.9);
    for (let i = 0; i < count; i++) {
      let x = px[i], y = py[i];
      // A slow curl-like flow: divergence-free, so it never clumps or empties.
      const fx = Math.sin(y * 3.1 + time) + 0.6 * Math.sin(y * 7.3 - time * 1.7 + x * 2.0);
      const fy = -Math.sin(x * 2.7 - time * 0.8) - 0.6 * Math.sin(x * 6.1 + time * 1.3 + y * 2.0);
      let ax = fx * 0.035, ay = fy * 0.035;
      if (forceOn) {
        const f = brushForce(x, y, b, 0.9);
        ax += f[0];
        ay += f[1];
      }
      vx[i] = (vx[i] + ax * dt) * drag;
      vy[i] = (vy[i] + ay * dt) * drag;
      x += (vx[i] + fx * 0.02) * dt;
      y += (vy[i] + fy * 0.02) * dt;
      if (x > 1.15) x -= 2.3; else if (x < -1.15) x += 2.3;
      if (y > 1.15) y -= 2.3; else if (y < -1.15) y += 2.3;
      px[i] = x;
      py[i] = y;
      if (birth[i] > reveal) continue;
      const sx = (w / 2 + x * scale) | 0;
      const sy = (h / 2 + y * scale) | 0;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const o = (sy * w + sx) << 2;
      const c = data[o] + gain; // Uint8ClampedArray saturates at white for us
      data[o] = c; data[o + 1] = c; data[o + 2] = c;
    }
    // The lone first particle, before the bloom takes over.
    if (intro.sparkAlpha > 0 && intro.heroBloom < 0.2) {
      const c = Math.round(255 * intro.sparkAlpha * (1 - intro.heroBloom * 5));
      const o = (((h / 2) | 0) * w + ((w / 2) | 0)) << 2;
      data[o] = data[o + 1] = data[o + 2] = Math.max(data[o], c);
    }
    ctx.putImageData(image, 0, 0);
  }

  const onVisibility = () => {
    const visible = doc.visibilityState === 'visible';
    if (visible && !running) { running = true; last = 0; raf = win.requestAnimationFrame(frame); }
    else if (!visible) { running = false; win.cancelAnimationFrame(raf); }
  };
  doc.addEventListener('visibilitychange', onVisibility);
  raf = win.requestAnimationFrame(frame);

  return {
    canvas,
    dispose() {
      running = false;
      win.cancelAnimationFrame(raf);
      ro.disconnect();
      gestures.dispose();
      canvas.removeEventListener('pointermove', trackDrag);
      doc.removeEventListener('visibilitychange', onVisibility);
      root.remove();
    },
  };
}
