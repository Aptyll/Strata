#!/usr/bin/env python3
"""
Turn raw QA captures from qa/challenge/run.mjs into annotated findings.

    python3 qa/challenge/annotate.py --in <raw dir> [<raw dir> ...] --out docs/qa/challenge

Every figure is built from exact offscreen readbacks (no screenshots), so the
pixel values in the numbers are the values the renderer produced. Figures whose
inputs are missing are skipped with a note. Needs Pillow and numpy; ffprobe and
ffmpeg for the MP4 figure.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- style ----

BG = (11, 11, 12)
PANEL = (0, 0, 0)
FG = (236, 236, 236)
DIM = (150, 150, 155)
RED = (255, 84, 84)
AMBER = (255, 184, 0)
GREEN = (72, 214, 132)
CYAN = (90, 200, 250)

FONT_DIR = "/usr/share/fonts/opentype/inter"


def font(size: int, weight: str = "Regular") -> ImageFont.FreeTypeFont:
    for path in (f"{FONT_DIR}/Inter-{weight}.otf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


F_TITLE = font(30, "SemiBold")
F_SUB = font(17)
F_LABEL = font(16, "Medium")
F_SMALL = font(14)
F_TINY = font(12)

FOOTER = "Exact offscreen readbacks from headless Chromium on a software GPU (SwiftShader), rendered from main at {commits}. Pixel values are real; speed was not measured."

# ----------------------------------------------------------------- data ----

INPUTS: list[str] = []


def find(name: str) -> str | None:
    for d in INPUTS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None


def meta(name: str) -> dict:
    p = find(name + ".json")
    if not p:
        raise FileNotFoundError(name)
    with open(p) as f:
        return json.load(f)


def rgba(name: str) -> np.ndarray:
    """First channel of an RGBA capture (all captures are monochrome)."""
    m = meta(name + ".rgba")
    a = np.fromfile(find(name + ".rgba"), np.uint8).reshape(m["height"], m["width"], 4)
    return a[:, :, 0]


def gray(name: str) -> np.ndarray:
    m = meta(name + ".gray")
    return np.fromfile(find(name + ".gray"), np.uint8).reshape(m["height"], m["width"])


def density(name: str) -> np.ndarray:
    m = meta(name + ".density")
    h, w = m["renderHeight"], m["renderWidth"]
    if m.get("densityFormat", "r32float") == "r32float":
        return np.fromfile(find(name + ".density"), np.float32).reshape(h, w)
    return np.fromfile(find(name + ".density"), np.float16).reshape(h, w).astype(np.float32)


def have(*names: str) -> bool:
    return all(find(n) for n in names)


def sibling(name: str, other: str) -> dict:
    """A JSON file from the same run folder as capture `name` (each run writes its own info.json and results.json)."""
    p = find(name)
    if not p:
        return {}
    try:
        with open(os.path.join(os.path.dirname(p), other)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def commit(name: str) -> str:
    """The main commit a capture was rendered from (info.json of its run folder)."""
    return sibling(name, "info.json").get("commit") or "?"


def older_rgba(name: str) -> tuple[np.ndarray, str] | None:
    """The same RGBA capture from the next --in folder that has it (an older run, if folders are listed newest first), and its commit."""
    hits = [d for d in INPUTS if os.path.exists(os.path.join(d, name + ".rgba"))]
    if len(hits) < 2:
        return None
    d = hits[1]
    with open(os.path.join(d, name + ".rgba.json")) as fh:
        m = json.load(fh)
    a = np.fromfile(os.path.join(d, name + ".rgba"), np.uint8).reshape(m["height"], m["width"], 4)[:, :, 0]
    try:
        with open(os.path.join(d, "info.json")) as fh:
            c = json.load(fh).get("commit") or "?"
    except (OSError, ValueError):
        c = "?"
    return a, c


def codes(name: str) -> np.ndarray:
    """The offline renderer's 16-bit developed frame, before grading and label."""
    m = meta(name + ".codes")
    return np.fromfile(find(name + ".codes"), "<u2").reshape(m["height"], m["width"])


def label_mask(h: int, w: int) -> np.ndarray:
    """True outside the box drawLabel darkens (bottom left, up to four lines), so frame statistics leave the label out."""
    scale = max(1, round(h / 540))
    m = np.ones((h, w), bool)
    m[max(0, h - 12 * scale - 4 * 10 * scale - 4 * scale):, :min(w, 430 * scale)] = False
    return m


def flux_keep() -> dict:
    """Results of the fluxKeep scenario (no capture files, so only a results.json holds them): kept shares and camera paths per count."""
    for d in INPUTS:
        try:
            with open(os.path.join(d, "results.json")) as fh:
                r = json.load(fh).get("fluxKeep")
        except (OSError, ValueError):
            continue
        if r:
            return r
    return {}


# -------------------------------------------------------------- drawing ----


@dataclass
class Fig:
    img: Image.Image
    draw: ImageDraw.ImageDraw


def figure(width: int, height: int, number: int, title: str, sub: str, severity: str, sources: list[str] | None = None) -> Fig:
    img = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(img)
    colour = {"high": RED, "medium": AMBER, "low": CYAN, "ok": GREEN, "fixed": GREEN}[severity]
    d.rectangle([0, 0, 8, 86], fill=colour)
    d.text((28, 16), f"{number:02d}  {title}", font=F_TITLE, fill=FG)
    d.text((30, 56), sub, font=F_SUB, fill=DIM)
    tag = {"high": "DEFECT, HIGH", "medium": "DEFECT, MEDIUM", "low": "MINOR", "ok": "CHECKED, OK", "fixed": "FIXED, VERIFIED"}[severity]
    tw = d.textlength(tag, font=F_LABEL)
    d.rounded_rectangle([width - tw - 48, 22, width - 24, 50], radius=6, outline=colour, width=2)
    d.text((width - tw - 36, 26), tag, font=F_LABEL, fill=colour)
    commits = sorted({commit(n) for n in sources or []}) or ["?"]
    d.text((28, height - 28), FOOTER.format(commits=" and ".join(commits)), font=F_TINY, fill=(110, 110, 115))
    return Fig(img, d)


def to_img(a: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert("RGB")


def paste(f: Fig, a: np.ndarray | Image.Image, x: int, y: int, w: int | None = None, label: str | None = None,
          sub: str | None = None, border: tuple | None = None, nearest: bool = False) -> tuple[int, int, float]:
    """Paste an image scaled to width w. Returns (width, height, scale)."""
    im = a if isinstance(a, Image.Image) else to_img(a)
    s = 1.0
    if w and im.width != w:
        s = w / im.width
        im = im.resize((w, round(im.height * s)), Image.NEAREST if nearest else Image.LANCZOS)
    f.img.paste(im, (x, y))
    if border:
        f.draw.rectangle([x - 1, y - 1, x + im.width, y + im.height], outline=border, width=2)
    if label:
        f.draw.text((x, y - 24), label, font=F_LABEL, fill=FG)
    if sub:
        f.draw.text((x, y + im.height + 6), sub, font=F_SMALL, fill=DIM)
    return im.width, im.height, s


def arrow(f: Fig, x0: float, y0: float, x1: float, y1: float, colour=RED, width: int = 3, head: float = 14) -> None:
    f.draw.line([x0, y0, x1, y1], fill=colour, width=width)
    ang = math.atan2(y1 - y0, x1 - x0)
    pts = [
        (x1, y1),
        (x1 - head * math.cos(ang - 0.4), y1 - head * math.sin(ang - 0.4)),
        (x1 - head * math.cos(ang + 0.4), y1 - head * math.sin(ang + 0.4)),
    ]
    f.draw.polygon(pts, fill=colour)


def callout(f: Fig, x: float, y: float, text: str, colour=RED, font_=None) -> None:
    font_ = font_ or F_SMALL
    lines = text.split("\n")
    w = max(f.draw.textlength(l, font=font_) for l in lines)
    h = len(lines) * (font_.size + 4)
    f.draw.rounded_rectangle([x - 6, y - 4, x + w + 6, y + h + 2], radius=4, fill=(0, 0, 0), outline=colour, width=1)
    for i, l in enumerate(lines):
        f.draw.text((x, y + i * (font_.size + 4)), l, font=font_, fill=colour if i == 0 else FG)


def text_block(f: Fig, x: int, y: int, lines: list[str], width: int, font_=None, colour=FG, gap: int = 6) -> int:
    """Word-wrapped paragraphs. Returns the y below the block."""
    font_ = font_ or F_SMALL
    for para in lines:
        if para == "":
            y += font_.size // 2
            continue
        bullet = para.startswith("- ")
        words = (para[2:] if bullet else para).split()
        indent = 16 if bullet else 0
        line = ""
        first = True
        for word in words:
            trial = f"{line} {word}".strip()
            if f.draw.textlength(trial, font=font_) > width - indent and line:
                f.draw.text((x + indent, y), line, font=font_, fill=colour)
                if bullet and first:
                    f.draw.text((x, y), "•", font=font_, fill=DIM)
                first = False
                y += font_.size + gap
                line = word
            else:
                line = trial
        if line:
            f.draw.text((x + indent, y), line, font=font_, fill=colour)
            if bullet and first:
                f.draw.text((x, y), "•", font=font_, fill=DIM)
            y += font_.size + gap
    return y


def chart(f: Fig, x: int, y: int, w: int, h: int, series: list[tuple[str, list[float], list[float], tuple]],
          xlabel: str, ylabel: str, xlog: bool = False, ylim: tuple | None = None, xlim: tuple | None = None,
          marks: list[tuple[float, str, tuple]] | None = None, hlines: list[tuple[float, str, tuple]] | None = None) -> None:
    """Minimal line chart: series of (name, xs, ys, colour)."""
    d = f.draw
    d.rectangle([x, y, x + w, y + h], fill=(18, 18, 20), outline=(60, 60, 65))
    xs_all = [v for _, xs, _, _ in series for v in xs]
    ys_all = [v for _, _, ys, _ in series for v in ys]
    x0, x1 = xlim or (min(xs_all), max(xs_all))
    y0, y1 = ylim or (min(ys_all), max(ys_all))
    if xlog:
        x0, x1 = math.log10(x0), math.log10(x1)
    pad = 10

    def px(v):
        v = math.log10(v) if xlog else v
        return x + pad + (v - x0) / ((x1 - x0) or 1) * (w - 2 * pad)

    def py(v):
        return y + h - pad - (v - y0) / ((y1 - y0) or 1) * (h - 2 * pad)

    for frac in (0.25, 0.5, 0.75):
        gy = y + pad + frac * (h - 2 * pad)
        d.line([x + 1, gy, x + w - 1, gy], fill=(32, 32, 36))
    for v, label, colour in hlines or []:
        d.line([x + 1, py(v), x + w - 1, py(v)], fill=colour, width=1)
        d.text((x + w - d.textlength(label, font=F_TINY) - 6, py(v) - 16), label, font=F_TINY, fill=colour)
    for v, label, colour in marks or []:
        d.line([px(v), y + 1, px(v), y + h - 1], fill=colour, width=1)
        d.text((px(v) + 4, y + 4), label, font=F_TINY, fill=colour)
    for name, xs, ys, colour in series:
        pts = [(px(a), py(b)) for a, b in zip(xs, ys)]
        if len(pts) > 1:
            d.line(pts, fill=colour, width=2)
        for p in pts if len(pts) < 40 else []:
            d.ellipse([p[0] - 3, p[1] - 3, p[0] + 3, p[1] + 3], fill=colour)
    d.text((x, y + h + 4), f"{xlabel}   [{_fmt(10 ** x0 if xlog else x0)} .. {_fmt(10 ** x1 if xlog else x1)}]", font=F_TINY, fill=DIM)
    d.text((x, y - 18), f"{ylabel}   [{_fmt(y0)} .. {_fmt(y1)}]", font=F_TINY, fill=DIM)
    ly = y + 8
    for name, _, _, colour in series:
        tw = d.textlength(name, font=F_TINY)
        d.rectangle([x + w - tw - 30, ly + 4, x + w - tw - 18, ly + 10], fill=colour)
        d.text((x + w - tw - 12, ly), name, font=F_TINY, fill=FG)
        ly += 16


def _fmt(v: float) -> str:
    a = abs(v)
    if a >= 1e6:
        return f"{v / 1e6:.3g}M"
    if a >= 1e3:
        return f"{v / 1e3:.3g}k"
    if a >= 10 or a == 0:
        return f"{v:.0f}"
    return f"{v:.3g}"


def gauss_blur(x: np.ndarray, s: float = 2) -> np.ndarray:
    """Separable Gaussian blur, sigma `s` pixels, zero outside the frame."""
    k = np.exp(-0.5 * (np.arange(-3 * s, 3 * s + 1) / s) ** 2)
    k /= k.sum()
    x = np.apply_along_axis(lambda v: np.convolve(v, k, "same"), 0, x)
    return np.apply_along_axis(lambda v: np.convolve(v, k, "same"), 1, x)


def diverging(lr: np.ndarray, valid: np.ndarray, vmax: float = 1.0) -> np.ndarray:
    """log2 ratio map: grey where equal, toward red where the second image is brighter, cyan where dimmer, black where neither has light."""
    t = np.clip(lr / vmax, -1, 1)[..., None]
    base = np.array((48, 48, 52), np.float32)
    out = base + np.clip(t, 0, 1) * (np.array(RED, np.float32) - base) + np.clip(-t, 0, 1) * (np.array(CYAN, np.float32) - base)
    out[~valid] = 0
    return out.astype(np.uint8)


def heat(a: np.ndarray, vmax: float) -> np.ndarray:
    """Black to amber to white ramp for difference maps."""
    t = np.clip(a / vmax, 0, 1)
    r = np.clip(t * 3, 0, 1)
    g = np.clip(t * 3 - 1, 0, 1) * 0.85 + np.clip(t * 3 - 2, 0, 1) * 0.15
    b = np.clip(t * 3 - 2, 0, 1)
    return (np.stack([r, g, b], -1) * 255).astype(np.uint8)


def save(f: Fig, out: str, name: str) -> None:
    path = os.path.join(out, name)
    if name.endswith(".jpg"):
        f.img.save(path, quality=90, optimize=True, progressive=True)
    else:
        f.img.save(path, optimize=True)
    print(f"wrote {path} ({os.path.getsize(path) // 1024} KB)")


# ------------------------------------------------------------- findings ----


def stat_line(im: np.ndarray) -> str:
    return f"mean {im.mean():.1f}   above 230: {(im > 230).mean() * 100:.1f}%"


def fig_washout(out: str) -> None:
    dp = ["overflow-e1-f0", "overflow-e1803-f0"]
    ct = ["overflow-e1-counts-f0", "overflow-e1803-counts-f0"]
    ladder = [f"ladder-{c}-f0" for c in (500000, 2000000, 8000000, 32000000)]
    need = [n + ".rgba" for n in dp + ct + ladder]
    if not have(*need):
        print("skip washout: inputs missing")
        return
    f = figure(1800, 980, 1, "The documented white point drifts with particle count; CountToneMapper does not",
               "src/render DensityPost with the docs/render.md recipe (white = 24 x mean, exposure 1) vs CountToneMapper  |  owner: Render density beyond screen resolution", "low", need)
    W = 420
    f.draw.text((30, 112), "docs recipe: DensityPost, white = 24 x mean density", font=F_LABEL, fill=AMBER)
    f.draw.text((30 + 2 * (W + 20), 112), "CountToneMapper: black and white points at percentiles of the frame", font=F_LABEL, fill=GREEN)
    ims = []
    x, y = 30, 170
    for n, lab in zip(dp + ct, ["17 particles per pixel", "31,000 particles per pixel"] * 2):
        im = rgba(n)
        ims.append(im)
        w, h, _ = paste(f, im, x, y, W, label=lab)
        f.draw.text((x, y + h + 6), stat_line(im), font=F_SMALL, fill=DIM)
        x += W + 20
    d_dp = float(np.abs(ims[0].astype(np.float32) - ims[1]).mean())
    d_ct = float(np.abs(ims[2].astype(np.float32) - ims[3]).mean())
    callout(f, 36, y + h + 34, f"identical frame, {d_dp:.1f} levels apart per pixel on average", AMBER, F_LABEL)
    callout(f, 36 + 2 * (W + 20), y + h + 34, f"identical frame, {d_ct:.2f} levels apart per pixel", GREEN, F_LABEL)

    y = 530
    f.draw.text((30, y - 52), "Real particle counts through the docs recipe (render demo source, 960x540, trails warmed up)", font=F_LABEL, fill=FG)
    x = 30
    means = []
    for n, c in zip(ladder, ("0.5M", "2M", "8M", "32M")):
        im = rgba(n)
        means.append(float(im.mean()))
        w, h, _ = paste(f, im, x, y, W)
        f.draw.text((x, y + h + 6), f"{c} particles: {stat_line(im)}", font=F_SMALL, fill=DIM)
        x += W + 20
    e1, e2 = ims[0], ims[1]
    text_block(f, 30, y + h + 44, [
        f"What: luma = ln(1 + exposure x density) / ln(1 + white). At exposure 1 the 1 is a black point of one particle, so once pixels hold thousands of particles every region sits far above it and the frame drifts toward white. The same frame at 17 and at 31,000 particles per pixel goes from {(e1 > 230).mean() * 100:.1f}% to {(e2 > 230).mean() * 100:.1f}% of pixels above 230, and real counts show the same drift ({means[0]:.0f} to {means[-1]:.0f} mean for 0.5M to 32M). CountToneMapper sets black at the 5th and white at the 99.9th percentile of lit pixels, so the picture does not depend on the count.",
        "Where it matters: only the render demo (src/render/demo/demo.ts, white = max(12, 24 x mean)) and the 'Offline and challenge renders' snippet in docs/render.md. The app uses a fixed white of 128 (brief V02), src/offline has its own percentile grade, and the trillion demo already uses CountToneMapper.",
        "Fix (suggested): point that snippet and the demo at CountToneMapper, or set exposure = 1 / (5th percentile of lit density). When brief V03 adds a black floor to CountToneMapper, set it from percentiles too, so this property survives.",
        "How the 31,000 frame was made: the same 4M particles at 1,803 times the energy, a stand-in for more particles that keeps the frame otherwise identical.",
    ], 1740, font_=F_SMALL)
    save(f, out, "01-white-point-drifts-with-count.jpg")


def fig_supersample(out: str) -> None:
    before = ["ss1-before-f0", "ss2-before-f0", "ss3-before-f0"]
    now = ["ss1-f0", "ss2-gain-f0", "ss3-gain-f0"]
    plain = ["ss2-f0", "ss3-f0"]
    need = [n + ".rgba" for n in before + now + plain]
    if not have(*need):
        print("skip supersample: inputs missing")
        return
    b = [rgba(n).astype(np.float32) for n in before]
    a = [rgba(n).astype(np.float32) for n in now]
    p = [rgba(n).astype(np.float32) for n in plain]
    y0, y1, x0, x1 = 300, 420, 560, 760
    box = (slice(y0, y1), slice(x0, x1))
    worst = max(abs(a[i].mean() / a[0].mean() - 1) for i in (1, 2))
    severity = "fixed" if worst < 0.05 else "low" if worst < 0.12 else "medium"
    f = figure(1800, 1100, 2, "Supersampled captures: the brightness loss is fixed" if severity == "fixed" else "Supersampled captures still come out darker",
               "src/capture Resampler and the app's capture gain, density look, 2M particles at 960x540, trails off  |  owner: Export MP4 videos for YouTube", severity, need)
    W = 560
    for r, (row, title) in enumerate(((b, f"before: main {commit(before[0] + '.rgba')}"), (a, f"now: main {commit(now[1] + '.rgba')}, with the app's capture gain (PR #96) and a linear-light downscale (PR #99)"))):
        y = 150 + r * 400
        f.draw.text((30, y - 30), title, font=F_LABEL, fill=FG)
        for i, im in enumerate(row):
            x = 30 + i * (W + 30)
            w, h, s = paste(f, im, x, y, W)
            f.draw.rectangle([x + x0 * s, y + y0 * s, x + x1 * s, y + y1 * s], outline=CYAN, width=2)
            d = (im.mean() / row[0].mean() - 1) * 100
            lab = ["1x (live view)", "supersample 2", "supersample 3"][i]
            f.draw.text((x, y + h + 8), f"{lab}: mean {im.mean():.1f} ({d:+.0f}%)   cyan box {im[box].mean():.1f}   brightest 1%: {np.percentile(im, 99):.0f}",
                        font=F_SMALL, fill=FG if i == 0 or abs(d) < 5 else AMBER)
    text_block(f, 30, 970, [
        f"Measured: before, the same frame was {(1 - b[1].mean() / b[0].mean()) * 100:.0f}% darker at supersample 2 and {(1 - b[2].mean() / b[0].mean()) * 100:.0f}% darker at 3. Now it is {(a[1].mean() / a[0].mean() - 1) * 100:+.0f}% and {(a[2].mean() / a[0].mean() - 1) * 100:+.0f}%. The linear-light downscale alone (PR #99, no gain) still gives {(p[0].mean() / a[0].mean() - 1) * 100:+.0f}% and {(p[1].mean() / a[0].mean() - 1) * 100:+.0f}%, so the gain is what restores the level.",
        f"Likely cause of the rest (not isolated here): the tone curve runs on each supersampled pixel before the average, and the log curve is concave, so sparse areas average darker while dense cores barely change (brightest 1%: {np.percentile(a[0], 99):.0f} at 1x, {np.percentile(a[1], 99):.0f} and {np.percentile(a[2], 99):.0f} supersampled). Downsampling the density before the tone map would avoid it.",
        "How this was rendered: the app applies the gain in src/main.ts, which this harness does not run, so it is reproduced here the same way: particle energy times supersample^2 at the 1x white point. A capture from the app itself was not checked.",
    ], 1740, font_=F_SMALL)
    save(f, out, "02-supersampled-captures.jpg")


def decode_y(mp4: str, W: int, H: int) -> np.ndarray:
    """Luma plane exactly as stored in the file, without any range conversion."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", mp4, "-f", "rawvideo", "-pix_fmt", "yuvj420p", "-"], capture_output=True, check=True).stdout
    fs = W * H * 3 // 2
    return np.stack([np.frombuffer(raw[i * fs:i * fs + W * H], np.uint8).reshape(H, W) for i in range(len(raw) // fs)])


def fig_mp4(out: str) -> None:
    mp4 = find("mp4.mp4")
    if not mp4 or not find("mp4-src-f45.rgba"):
        print("skip mp4: inputs missing")
        return
    m = meta("mp4.mp4")
    W, H = m["width"], m["height"]
    dec = decode_y(mp4, W, H).astype(np.float32)
    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_packets", "-of", "json", mp4],
                                      capture_output=True, check=True, text=True).stdout)
    st = probe["streams"][0]
    packets = probe["packets"]
    keys = [i for i, pk in enumerate(packets) if "K" in pk.get("flags", "")]
    src = np.stack([rgba(f"mp4-src-f{k}") for k in range(len(dec))]).astype(np.float32)
    psnr = [10 * math.log10(255 ** 2 / max(((s - d) ** 2).mean(), 1e-9)) for s, d in zip(src, dec)]
    lit = src > 0
    misread = np.clip(np.round((dec - 16) * 255 / 219), 0, 255)
    lost = float((misread[lit] < 0.5).mean() * 100)
    clipped = float((misread >= 254.5).mean() * 100)
    dust = []
    for c in ("40M", "400M"):
        for mo in range(5):
            if find(f"offline-{c}-f{mo}.gray"):
                g = gray(f"offline-{c}-f{mo}")
                g = g[label_mask(*g.shape)]
                dust.append(float((g[g > 0] < 16).mean() * 100))
    dust_line = (f" In the trillion shot's graded frames (offline renderer, 40M and 400M here) {min(dust):.0f}% to {max(dust):.0f}% of the lit pixels are below 16/255, so its far dust would vanish the same way." if dust else "")
    f = figure(1800, 1060, 3, "MP4 recorder: full-range output risks losing the faint light",
               "src/capture startRecording with its defaults (H.264, 0.15 bits per pixel, keyframe every 0.5 s), fed density-look frames  |  owners: Export MP4 videos for YouTube, offline renderer (web export)",
               "medium", ["mp4.mp4", "offline-seq.mp4"] if find("offline-seq.mp4") else ["mp4.mp4"])
    k = 45
    # Crop where the faint dust is: the 220x130 window holding the most lit source pixels below 16.
    faint = ((src[k] > 0) & (src[k] < 16)).astype(np.float64)
    cs = np.pad(faint, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    cw, ch = 220, 130
    best = max(((cs[y + ch, x + cw] - cs[y, x + cw] - cs[y + ch, x] + cs[y, x], y, x)
                for y in range(0, H - ch, 10) for x in range(0, W - cw, 10)))
    y0, x0 = best[1], best[2]
    y1, x1 = y0 + ch, x0 + cw
    gain = 6
    paste(f, src[k], 30, 140, 560, label=f"source frame {k}")
    s = 560 / W
    f.draw.rectangle([30 + x0 * s, 140 + y0 * s, 30 + x1 * s, 140 + y1 * s], outline=CYAN, width=2)
    paste(f, dec[k][y0:y1, x0:x1] * gain, 620, 140, 560, nearest=True, border=CYAN, label=f"decoded as tagged (full range), display gain x{gain}")
    paste(f, misread[k][y0:y1, x0:x1] * gain, 1210, 140, 560, nearest=True, border=RED, label=f"decoded as limited range, same gain x{gain}")
    f.draw.text((620, 140 + 331 + 8), f"mean |error| {np.abs(src[k] - dec[k]).mean():.2f} levels over the frame", font=F_SMALL, fill=DIM)
    lost_crop = float((misread[k][y0:y1, x0:x1][src[k][y0:y1, x0:x1] > 0] < 0.5).mean() * 100)
    f.draw.text((1210, 140 + 331 + 8), f"{lost_crop:.0f}% of the lit pixels here turn black ({lost:.0f}% over the video)", font=F_SMALL, fill=RED)
    chart(f, 30, 560, 860, 240, [("PSNR per frame (dB)", list(range(len(psnr))), psnr, CYAN)], "frame (60 fps)", "PSNR of decoded vs source, dB",
          marks=[(kk, "I", AMBER) for kk in keys], ylim=(min(psnr) - 1, max(psnr) + 1))
    void = float(dec[~lit].mean())
    sizes = [int(pk["size"]) for pk in packets]
    rows = [
        ("codec", f"{st.get('codec_name')} {st.get('profile')}, level {st.get('level')}; {len(dec)} frames at {st.get('avg_frame_rate')} fps, keyframes at {keys}"),
        ("bitrate", f"{int(st.get('bit_rate', 0)) / 1e6:.2f} Mbit/s; I-frames {np.mean([sizes[i] for i in keys]) / 1024:.0f} KB, P-frames {np.mean([z for i, z in enumerate(sizes) if i not in keys]) / 1024:.1f} KB"),
        ("quality", f"PSNR {np.mean(psnr):.1f} dB mean, {min(psnr):.1f} to {max(psnr):.1f}; it varies frame to frame in a short cycle, not as a slow drift within each keyframe interval"),
        ("black, white", f"void decodes to {void:.2f} on average (0 = black); lit pixels keep their level ({dec[lit].mean():.1f} vs {src[lit].mean():.1f} in the source)"),
        ("colour tags", f"{st.get('pix_fmt')}, range {st.get('color_range')}, matrix {st.get('color_space')}, transfer {st.get('color_transfer')}, primaries {st.get('color_primaries')}"),
    ]
    seq = find("offline-seq.mp4")
    if seq:
        s2 = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", seq],
                                       capture_output=True, check=True, text=True).stdout)["streams"][0]
        rows.append(("1T web export", f"the offline renderer's export of the trillion shot (src/offline/web, 640x360 here): {s2.get('pix_fmt')}, range {s2.get('color_range')}, matrix {s2.get('color_space')}, transfer {s2.get('color_transfer')}, primaries {s2.get('color_primaries')}"))
    y = 560
    for kk, v in rows:
        f.draw.text((930, y), kk, font=F_LABEL, fill=DIM)
        y = text_block(f, 1060, y, [v], 710, font_=F_SMALL)
        y += 4
    text_block(f, 30, 860, [
        "Fine: decoded as tagged, black stays black, levels and the dim dust survive, and the frame count and timing are exact.",
        f"Risk: the file is full-range YUV (yuvj420p) tagged with the sRGB transfer curve, carried over from the frames' sRGB colour space. Players and YouTube's own ingest read the range flag, so a direct upload is probably fine (it cannot be checked from here). But an editor or converter that ignores the flag treats it as limited range: in this video every lit pixel whose source value is below 16/255 turns black ({lost:.0f}% of the lit pixels: the fringe and bloom halo here) and {clipped:.1f}% of pixels clip to white.{dust_line} This path matters for the 1T video: src/offline/web exports through startRecording, and Noah's PC cannot run the Node CLI's ffmpeg encode.",
        "Fix (suggested): write BT.709 limited range, the default every tool assumes: convert to I420 in BT.709 limited range and hand the encoder VideoFrames that carry that colorSpace. Until then, for a file that will be edited, re-encode it once with ffmpeg to bt709 tv range before editing.",
        "Not representative of Noah's machine: in this sandbox Chromium encodes in software. A hardware encoder will differ in quality, and possibly in tags; check one export with ffprobe.",
    ], 1740, font_=F_SMALL)
    save(f, out, "03-mp4-full-range.jpg")


def fig_label(out: str) -> None:
    before = ["offline-before-40M-f2", "offline-before-400M-f4"]
    now = ["offline-40M-f2", "offline-400M-f4"]
    need = [n + ".gray" for n in before + now]
    if not have(*need):
        print("skip label: inputs missing")
        return
    f = figure(1800, 600, 4, "The burned-in particle count stays readable over bright sheets",
               "src/offline/core/grade.ts drawLabel, the trillion shot at 40M and 400M particles (640x360)  |  owner: Render offline record-scale particle video", "fixed", need)
    lab = (302, 356, 0, 430)
    y = 150
    zoom = 860 / (lab[3] - lab[2])
    for r, (names, title) in enumerate(((before, f"before: main {commit(before[0] + '.gray')}, glyphs max-blended at 115/255"), (now, f"now: main {commit(now[0] + '.gray')}, the box behind each line is darkened first (PR #67)"))):
        f.draw.text((30, y - 28), title, font=F_LABEL, fill=AMBER if r == 0 else GREEN)
        x = 30
        for n in names:
            g = gray(n)
            crop = g[lab[0]:lab[1], lab[2]:lab[3]]
            w, h, _ = paste(f, crop, x, y, 860, nearest=True, border=AMBER if r == 0 else GREEN)
            x += 880
        y += h + 70
    text_block(f, 30, y - 20, [
        f"Label region of two frames, {zoom:.1f}x nearest-neighbour zoom. Before, a sheet brighter than the label erased its strokes (on the real 1T frame key1 the count read '1,000,000,00?,?00'; brief V06). Now each line sits on a box darkened to 20% and the glyphs are drawn at full label value, so the count reads over any frame, including the fourth line the label gained since (the flux-weighting note). Frames are the same moments of the shot (halfway and the end); the grade also changed to contrast 256 (Noah's pick), which is why the sheets look darker.",
    ], 1740, font_=F_SMALL)
    save(f, out, "04-offline-label-readable.jpg")


def spectrum_peak(g: np.ndarray) -> tuple[float, float]:
    """Largest isolated spectral peak relative to its 15x15 neighbourhood (log-mean), away from DC and the axes, and its period in pixels."""
    H, W = g.shape
    win = np.outer(np.hanning(H), np.hanning(W))
    L = np.log1p(np.abs(np.fft.fftshift(np.fft.fft2((g - g.mean()) * win))))
    k, h = 15, 7
    pad = np.pad(L, ((h + 1, h), (h + 1, h)), mode="edge")
    cs = pad.cumsum(0).cumsum(1)
    box = ((cs[k:, k:] - cs[:-k, k:] - cs[k:, :-k] + cs[:-k, :-k]) / (k * k))[:H, :W]
    r = np.exp(L - box)
    cy, cx = H // 2, W // 2
    yy, xx = np.mgrid[0:H, 0:W]
    # Away from DC and the axes, and from the spectrum's outer edge, where the
    # neighbourhood is mostly edge padding and the ratio is not meaningful.
    away = (np.abs(yy - cy) > 8) & (np.abs(xx - cx) > 8) & (yy >= 8) & (yy < H - 8) & (xx >= 8) & (xx < W - 8)
    r = np.where(away, r, 0)
    py, px = np.unravel_index(int(np.argmax(r)), r.shape)
    return float(r[py, px]), float(1 / math.hypot((py - cy) / H, (px - cx) / W))


def noise_peak(g: np.ndarray) -> float:
    """spectrum_peak of the same pixels shuffled: what pure noise with this histogram reaches at this size."""
    return spectrum_peak(np.random.default_rng(1).permutation(g.ravel()).reshape(g.shape))[0]


def fig_offline_counts(out: str) -> None:
    counts = ["4M", "40M", "400M"]
    names = [f"offline-{c}-f{m}" for c in counts for m in range(5)]
    need = [n + ".gray" for n in names] + ["offline-400M-point-f4.gray"]
    if not have(*need):
        print("skip offline counts: inputs missing")
        return
    f = figure(1800, 1340, 5, "1T offline renderer at 4M, 40M and 400M particles: no lattice, no repetition",
               "src/offline trillion preset scaled down: 1024 sheets, the real 600-frame move, frames 0, 150, 300, 449 and 599 at 640x360, default grade  |  owner: Render offline record-scale particle video",
               "ok", need)
    tw = 320
    for r, c in enumerate(counts):
        y = 150 + r * 210
        f.draw.text((30, y + 80), c, font=F_TITLE, fill=FG)
        for mo in range(5):
            g = gray(f"offline-{c}-f{mo}")
            m = meta(f"offline-{c}-f{mo}.gray")
            keep = label_mask(*g.shape)
            paste(f, g, 150 + mo * (tw + 10), y, tw)
            f.draw.text((150 + mo * (tw + 10), y + 190), f"mean {g[keep].mean():.0f}  clipped {(g[keep] == 255).mean() * 100:.2f}%", font=F_TINY, fill=DIM)
            if r == 0:
                f.draw.text((150 + mo * (tw + 10), 124), f"frame {m['frame']}", font=F_SMALL, fill=DIM)
    y = 850
    bil = gray("offline-400M-f4").astype(np.float32)
    pt = gray("offline-400M-point-f4").astype(np.float32)
    crop = (slice(60, 200), slice(300, 520))
    paste(f, bil[crop], 30, y, 440, nearest=True, border=CYAN, label="frame 599, 400M, bilinear splat (2x zoom)")
    paste(f, pt[crop], 500, y, 440, nearest=True, border=AMBER, label="same frame, point splat (the 1T record's)")

    def hf(g: np.ndarray) -> float:
        sp = np.abs(np.fft.fftshift(np.fft.fft2(g - g.mean()))) ** 2
        H, W = g.shape
        yy, xx = np.mgrid[-H // 2:H - H // 2, -W // 2:W - W // 2]
        rr = np.hypot(yy / (H / 2), xx / (W / 2))
        return float(sp[rr > 0.5].sum() / sp.sum() * 100)

    grays = {n: gray(n) for n in names}
    keep = label_mask(*grays[names[0]].shape)
    peaks = [spectrum_peak(grays[n].astype(np.float32))[0] for n in names]
    noise = noise_peak(grays["offline-400M-f2"].astype(np.float32))
    rec = []
    rec_noise = None
    for n in ("trillion-still-f0", "trillion-key1-f0", "trillion-key2-f0", "trillion-A", "trillion-B", "trillion-C"):
        p = find(n + ".png")
        if p:
            im = np.asarray(Image.open(p).convert("L"), dtype=np.float32)
            rec.append((n, *spectrum_peak(im)))
            if rec_noise is None:
                rec_noise = noise_peak(im)
    means = {c: [float(grays[f"offline-{c}-f{mo}"][keep].mean()) for mo in range(5)] for c in counts}
    gap = [abs(a - b) for a, b in zip(means["40M"], means["400M"])]
    clip = max(float((grays[n][keep] == 255).mean() * 100) for n in names)
    # The void: pixels the renderer left at zero must grade to exactly zero.
    lit_void = sum(int(((codes(n) == 0) & keep & (grays[n] > 0)).sum()) for n in names)
    void = sum(int(((codes(n) == 0) & keep).sum()) for n in names)
    if rec:
        top = max(rec, key=lambda t: t[1])
        rest = [t for t in rec if t is not top]
        rec_line = (f"- Real 1T frames from the RTX 2070 (docs/record): " + ", ".join(f"{n.replace('trillion-', '')} {v:.1f}x" for n, v, _ in rec)
                    + f"; shuffled pixels reach {rec_noise:.1f}x at 4K. " + (f"Only {top[0].replace('trillion-', '')} stands out, at a {top[2]:.0f} px period: the rings of its ring sheet, designed content (its point-splat moire is listed in docs/briefs/visual as reviewed, no brief needed)." if top[1] > 1.25 * max(v for _, v, _ in rest) else "None stands out."))
    else:
        rec_line = "- Real 1T frames (docs/record): not found in the inputs."
    jobs = {c: meta(f"offline-{c}-f0.gray")["job"] for c in counts}
    end = {c: jobs[c]["camera"][-1]["distance"] for c in counts}
    same = [c for c in counts if abs(end[c] - end["4M"]) < 1e-9]
    paths = flux_keep().get("paths", [])
    def dist(n: float, fr: int) -> float | None:
        return next((p_["distance"] for p_ in paths if p_["particles"] == n and p_["frame"] == fr), None)
    split = next((fr for fr in range(600) if dist(4e7, fr) is not None and abs(dist(4e7, fr) - dist(4e8, fr)) > 1e-6 * dist(4e7, fr)), None)
    end_1t = dist(1e12, 599)
    # Mark the frames where the 400M path differs (camera keys after t = 0.68).
    if end["400M"] != end["40M"]:
        x0 = 150 + 2 * (tw + 10)
        th = tw * 360 // 640
        f.draw.rectangle([x0 - 4, 150 + 2 * 210 - 4, 150 + 4 * (tw + 10) + tw + 3, 150 + 2 * 210 + th + 3], outline=AMBER, width=2)
        callout(f, x0, 150 + 2 * 210 + th + 30, f"400M: another fluxRef, and a camera path of its own" + (f" from frame {split}" if split is not None else "") + f" (it ends at {end['400M']:.2f}, not {end['40M']:.2f})", AMBER, F_TINY)
    text_block(f, 980, y - 4, [
        "Checked, nothing wrong found:",
        f"- No grid, lattice or repeating pattern. The strongest isolated peak in any of these 15 spectra is {max(peaks):.1f}x its neighbourhood; the same pixels shuffled reach {noise:.1f}x, and a lattice would stand far above both. Positions come from 64-bit Feistel keys (src/stateless), bijective per sheet.",
        rec_line,
        f"- Point vs bilinear at 400M: high-frequency energy {hf(pt):.1f}% vs {hf(bil):.1f}% of the spectrum. The trillion preset picks the point splat above 2e10 particles (src/offline/core/world.ts); at 1T density each pixel averages many hits, so this matters for fine periodic content such as rings, not for dust.",
        f"- Void stays exactly black ({lit_void} of {void:,} zero-count pixels graded above 0), at most {clip:.2f}% of any frame clips (label box excluded), and the 64-bit grid cannot overflow: all 1e12 particles in one pixel at 65,536 units each is 6.6e16, under 2^64 = 1.8e19.",
        "Worth knowing for previews (by design, not a defect):",
        f"- The shot is built for its particle count: world.ts puts the camera's closest approach where the hero sheet shows about one particle per 20 pixels, and sets fluxRef to 4x that distance. {' and '.join(same)} share one path (end distance {end['4M']:.2f}, fluxRef {jobs['4M']['fluxRef']:.2f}); 400M has fluxRef {jobs['400M']['fluxRef']:.2f} and a path that leaves theirs at frame {split} and ends at {end['400M']:.2f}"
        + (f"; the real 1T job in 4K ends at {end_1t:.3f}, {end['400M'] / end_1t:.0f}x closer again." if end_1t else ".")
        + f" The lower fluxRef also weights sheets near the camera more against far ones; with the path change, frame 300 already looks different. So a preview at fewer particles shows the 1T framing only through frame {split - 1 if split else '?'}, and its near-sheet brightness only while no sheet is within fluxRef of the camera.",
        f"- On one path, the wide frames are already converged (4M vs 40M: means {means['4M'][0]:.0f} vs {means['40M'][0]:.0f} at frame 0, {means['4M'][1]:.0f} vs {means['40M'][1]:.0f} at 150), but big near sheets are still sparse dots at 4M and fill in at 40M ({means['4M'][2]:.0f} vs {means['40M'][2]:.0f}, {means['4M'][3]:.0f} vs {means['40M'][3]:.0f}, {means['4M'][4]:.0f} vs {means['40M'][4]:.0f} at frames 300, 449, 599). At 1T every pixel is far denser, so those frames will read brighter than any small preview.",
    ], 790, font_=F_SMALL)
    save(f, out, "05-offline-counts.jpg")


def fig_offline_short_jobs(out: str) -> None:
    names = [f"offline-short-40M-f{m}" for m in range(5)]
    need = [n + ".gray" for n in names] + [f"offline-40M-f{m}.gray" for m in range(5)]
    if not have(*need):
        print("skip short jobs: inputs missing")
        return
    f = figure(1800, 760, 10, "Short offline jobs smear the whole camera move since camera blur landed",
               "src/offline/core/renderer.ts camera motion blur (PR #92): shutter span = shutter / (frames - 1) of the path  |  owner: Render offline record-scale particle video", "low", need)
    tw = 336
    for r, (pre, title) in enumerate((("offline-short-40M", "a 5-frame job of the trillion shot (the whole move in 5 frames)"), ("offline-40M", "the same five path positions inside the real 600-frame job"))):
        y = 150 + r * 240
        f.draw.text((30, y - 28), title, font=F_LABEL, fill=AMBER if r == 0 else GREEN)
        for mo in range(5):
            paste(f, gray(f"{pre}-f{mo}"), 30 + mo * (tw + 12), y, tw)
    text_block(f, 30, 640, [
        "The camera path runs over the job's frames, and the shutter now spans 0.5 / (frames - 1) of it, so a short job is a very fast camera and blurs like one. The 600-frame record clip is fine (1/1200 of the move per frame). A 1-frame still has no camera blur. Anything in between is a fast camera: a 12-frame job (the smoke preset's length) spans 4.5% of its move per frame. If short jobs are meant as previews of the trillion move, give them shutter 0, or take the camera blur span from the full clip's frame interval.",
    ], 1740, font_=F_SMALL)
    save(f, out, "10-short-jobs-smear.jpg")


def fig_challenge(out: str) -> None:
    sim = ["1M", "4M", "17M"]
    proc = ["1M", "4M", "17M", "67M"]
    names = [f"challenge-sim-{c}-f0" for c in sim] + [f"challenge-proc-{c}-f0" for c in proc]
    alt = "challenge-proc-4M-e0.008-f0"
    need = [n + ".rgba" for n in names + [alt]]
    if not have(*need):
        print("skip challenge: inputs missing")
        return
    f = figure(1800, 1010, 6, "Challenge mode: caustic cores clip at the default exposure",
               "src/challenge kernel and resolve, the page's world (24 sheets) and start pose, 960x540, offscreen  |  owner: Build challenge mode for record particle counts", "low", need)
    tw = 420
    missing, peaks, proc_means = [], [], []
    for r, (mode, cs) in enumerate((("sim", sim), ("proc", proc))):
        y = 150 + r * 330
        f.draw.text((30, y - 26), "simulated (stored state, after 1 s of simulation)" if mode == "sim" else "procedural (stateless)", font=F_LABEL, fill=FG)
        for i, c in enumerate(cs):
            im = rgba(f"challenge-{mode}-{c}-f0")
            x = 30 + i * (tw + 20)
            w, h, s = paste(f, im, x, y, tw)
            clip = im == 255
            if clip.any():
                ys, xs = np.nonzero(clip)
                ov = f.img.load()
                for yy, xx in zip(ys[::3], xs[::3]):
                    ov[x + int(xx * s), y + int(yy * s)] = RED
            litv = im[im > 0]
            f.draw.text((x, y + h + 6), f"{c}: mean {im.mean():.0f}, clipped {clip.mean() * 100:.1f}% (red), median lit {np.median(litv):.0f}", font=F_SMALL, fill=DIM)
            present = np.unique(litv)
            missing.append(256 - int(present.min()) - len(present))
            if mode == "proc":
                peaks.append(spectrum_peak(im.astype(np.float32))[0])
                proc_means.append(float(im.mean()))
    im = rgba(alt)
    base = rgba("challenge-proc-4M-f0")
    sim4 = rgba("challenge-sim-4M-f0")
    mid = rgba("challenge-proc-4M-e0.012-f0") if have("challenge-proc-4M-e0.012-f0.rgba") else None
    op, osim = older_rgba("challenge-proc-4M-f0"), older_rgba("challenge-sim-4M-f0")
    now_c = commit("challenge-proc-4M-f0.rgba")
    if op and osim and op[1] != now_c:
        v02_line = (f"Related: brief V02 is done here. PR #139 dropped the 1/2.2 power after the log curve, so between {op[1]} and {now_c} the median lit pixel at 4M went from "
                    f"{np.median(op[0][op[0] > 0]):.0f} to {np.median(base[base > 0]):.0f} (procedural) and from {np.median(osim[0][osim[0] > 0]):.0f} to {np.median(sim4[sim4 > 0]):.0f} (simulated), "
                    f"while clipping stayed at {(op[0] == 255).mean() * 100:.1f}% and {(base == 255).mean() * 100:.1f}%: the clip point does not depend on the curve. That PR left the clipping open (curve or exposure).")
    else:
        v02_line = f"Related: brief V02 (tone curve and mid-greys): the median lit pixel at 4M is {np.median(base[base > 0]):.0f} of 255 procedural and {np.median(sim4[sim4 > 0]):.0f} simulated."
    mid_line = (f" Exposure 0.012 leaves {(mid == 255).mean() * 100:.2f}% clipped at {(1 - mid.mean() / base.mean()) * 100:.0f}% less mean brightness." if mid is not None else "")
    y = 150 + 330
    x = 30 + 3 * (tw + 20)
    # Put the exposure test under the sim row's empty slot.
    w, h, s = paste(f, im, x, 150, tw, label="procedural 4M at exposure 0.008", border=GREEN)
    clip = im == 255
    f.draw.text((x, 150 + h + 6), f"clipped {clip.mean() * 100:.2f}%, median lit {np.median(im[im > 0]):.0f}, mean {im.mean():.0f} (was {base.mean():.0f})", font=F_SMALL, fill=GREEN)
    text_block(f, 30, 830, [
        "Looks right: brightness converges as the count rises (procedural means " + ", ".join(f"{m_:.0f}" for m_ in proc_means) + " from 1M to 67M; the resolve is normalised by count, so a pixel's u32 never wraps), "
        + ("no grey level is missing between the dimmest lit level and white in any of the 7 frames (no banding)" if max(missing) == 0
           else f"at most {max(missing)} grey level{'s are' if max(missing) > 1 else ' is'} missing between the dimmest lit level and white in any of the 7 frames" + (" (no banding)" if max(missing) <= 2 else ""))
        + f", and the procedural caustics show no repetition (strongest isolated spectral peak {max(peaks):.1f}x its neighbourhood; the same pixels shuffled reach {noise_peak(rgba('challenge-proc-4M-f0').astype(np.float32)):.1f}x).",
        f"Minor: in procedural mode {(base == 255).mean() * 100:.1f}% of the frame clips to flat white at the caustic cores at every count, which the resolve's comment says it avoids. The clip point is light = 1 / exposure whatever the curve, so raising `curve` does not help. Rendered above with only the exposure changed: 0.008 cuts clipping to {(im == 255).mean() * 100:.2f}% and costs {(1 - im.mean() / base.mean()) * 100:.0f}% of mean brightness.{mid_line}",
        v02_line,
    ], 1740, font_=F_SMALL)
    save(f, out, "06-challenge-counts.jpg")


def block_motion(a: np.ndarray, b: np.ndarray, B: int = 16, R: int = 12) -> tuple[float, float, float]:
    """Median block shift (px) and mean |difference| before and after the best shift, over lit blocks."""
    H, W = a.shape
    shifts, before, after = [], [], []
    for y in range(R, H - B - R, B):
        for x in range(R, W - B - R, B):
            blk = b[y:y + B, x:x + B]
            if blk.mean() < 8:
                continue
            best = (1e9, 0, 0)
            for dy in range(-R, R + 1, 1):
                for dx in range(-R, R + 1, 1):
                    e = float(np.abs(a[y + dy:y + dy + B, x + dx:x + dx + B] - blk).mean())
                    if e < best[0]:
                        best = (e, dy, dx)
            shifts.append(math.hypot(best[1], best[2]))
            before.append(float(np.abs(a[y:y + B, x:x + B] - blk).mean()))
            after.append(best[0])
    return float(np.median(shifts)), float(np.mean(before)), float(np.mean(after))


def fig_temporal(out: str) -> None:
    sets = [
        ("render demo, moving (trails on)", "flicker-motion", 6, "rgba"),
        ("render demo, frozen scene", "flicker-static", 4, "rgba"),
        ("challenge, procedural, moving", "challenge-proc-seq", 4, "rgba"),
        ("1T offline, frames 300 to 307", "offline-mid", 8, "gray"),
    ]
    def nm(tag, k, kind):
        return f"{tag}-f{300 + k if tag == 'offline-mid' else k}.{kind}"
    need = [nm(t, k, kind) for _, t, n, kind in sets for k in range(n)]
    if not have(*need):
        print("skip temporal: inputs missing")
        return
    f = figure(1800, 900, 7, "No flicker between consecutive frames, and the void stays black",
               "Global brightness per frame and per-pixel change between frames, for each path  |  owners: render, challenge and offline threads (FYI)", "ok", need)
    series = []
    colours = [CYAN, GREEN, AMBER, RED]
    x = 30
    summary = []
    frames_by = {}
    for i, (label, tag, n, kind) in enumerate(sets):
        frames = [(rgba if kind == "rgba" else gray)(nm(tag, k, kind).rsplit(".", 1)[0]).astype(np.float32) for k in range(n)]
        frames_by[tag] = frames
        means = [float(fr.mean()) for fr in frames]
        diffs = [float(np.abs(frames[k + 1] - frames[k]).mean()) for k in range(n - 1)]
        series.append((label, list(range(n)), [mm - means[0] for mm in means], colours[i]))
        d = np.abs(frames[1] - frames[0])
        w, h, s = paste(f, heat(d, 32), x, 150, 420, label=label)
        f.draw.text((x, 150 + h + 6), f"|frame 1 - frame 0|: mean {diffs[0]:.2f} levels", font=F_SMALL, fill=DIM)
        summary.append(f"- {label}: mean change {np.mean(diffs):.2f} levels per pixel per frame; the frame mean moves {max(means) - min(means):.2f} levels over {n} frames.")
        x += 440
    chart(f, 30, 520, 860, 260, series, "frame", "change in mean brightness vs frame 0 (levels)", ylim=(-4, 4))
    st = frames_by["flicker-static"]
    black_all = float(np.all([fr == 0 for fr in st], axis=0).mean() * 100)
    stack = np.stack(st)
    blink = (stack > 0).any(0) & (stack == 0).any(0)
    blink_pct = float(blink.mean() * 100)
    blink_max = int(stack[:, blink].max()) if blink.any() else 0
    om = frames_by["offline-mid"]
    shift, before, after = block_motion(om[0], om[1])
    text_block(f, 930, 500, [
        "Global brightness moves smoothly on every path: no pumping, no frame-to-frame flicker.",
        *summary,
        "",
        f"Frozen scene: {black_all:.0f}% of pixels are black in all four frames. {blink_pct:.1f}% switch between 0 and at most level {blink_max} of 255, the dither at the faintest fringe; nothing in the void sparkles brighter (PR #74 limits dither to the distance from black).",
        f"1T mid-clip: the large per-pixel change is camera motion, not noise. Lit 16 px blocks move a median {shift:.1f} px per frame at 640x360 (about {shift * 6:.0f} px at 4K), and the best shift cuts their difference from {before:.0f} to {after:.0f} levels. Camera moves blur since PR #92.",
        "Challenge mode has no trails, so sparse regions boil more per pixel: fine grain live, but it costs bits in a video.",
    ], 840, font_=F_SMALL)
    save(f, out, "07-temporal-stability.jpg")


def fig_ramp(out: str) -> None:
    names = ["ramp-default", "ramp-nodither", "ramp-filmic"]
    if not have(*[n + ".rgba" for n in names]):
        print("skip ramp: inputs missing")
        return
    f = figure(1800, 740, 8, "Tone curve on smooth density ramps: no banding with dither on",
               "src/render DensityPost, synthetic r32float ramps (no particles), bloom and trails off  |  owner: Render density beyond screen resolution (FYI)", "ok", [n + ".rgba" for n in names])
    m = meta("ramp-default.rgba")
    band = m["band"]
    y = 150
    for n, lab in zip(names, ["default (log, soft shoulder, dither 1)", "dither 0", "filmic display"]):
        a = rgba(n)
        paste(f, a, 30, y, 1024, label=lab)
        y += a.shape[0] + 44
    f.draw.text((1070, 150), "rows: 1e-3 .. 1e3 x white (log), 0 .. 2% of white, 0.25 .. 4 x white", font=F_SMALL, fill=DIM)
    a0, a1 = rgba("ramp-default").astype(np.float32), rgba("ramp-nodither").astype(np.float32)
    dark0, dark1 = a0[band:2 * band], a1[band:2 * band]
    row = dark1[band // 2]
    runs, cur = [], 1
    for i in range(1, len(row)):
        if row[i] == row[i - 1]:
            cur += 1
        else:
            runs.append(cur)
            cur = 1
    runs.append(cur)
    xs = list(range(a0.shape[1]))
    chart(f, 1070, 200, 700, 240, [("dither 0", xs, list(row), RED), ("dither 1, column mean", xs, list(dark0.mean(0)), GREEN)],
          "x along the 0 .. 2% of white ramp", "output level (8-bit), the two lines overlap")
    clip_x = int(np.argmax(a0[:band].mean(0) >= 254.5))
    d0 = 1e-3 * (1e6) ** (clip_x / a0.shape[1]) if clip_x else float("nan")
    text_block(f, 1070, 480, [
        f"Without dither the dark ramp steps in flat runs up to {max(runs)} px wide; with dither the column means follow the ramp smoothly, and the dither adds no bias ({dark0.mean():.2f} vs {dark1.mean():.2f} mean level). Since PR #74 it works on the sRGB value and shrinks near black, and the frozen-scene test in 07 shows the void staying at 0.",
        f"The default curve reaches full white at {d0:.2f} x the white point (soft shoulder) and keeps 1e-3 x white visible (level {a0[:band, :4].mean():.0f}). Filmic never clips (its brightest output is {int(rgba('ramp-filmic').max())} of 255) but pushes the bottom decade toward black.",
        "Nothing to fix here. After video compression the 1-level dither is mostly gone; see 03 for what the MP4 keeps.",
    ], 700, font_=F_SMALL)
    save(f, out, "08-tone-ramps.jpg")


def fig_trillion(out: str) -> None:
    names = ["trillion-point", "trillion-stochastic", "trillion-stochastic-salt1"]
    need = [n + ".rgba" for n in names]
    if not have(*need) or not have(*[n + ".counts" for n in names]):
        print("skip trillion: inputs missing")
        return
    ms = [meta(n + ".rgba") for n in names]
    W, H = ms[0]["width"], ms[0]["height"]
    ims = [rgba(n).astype(np.float32) for n in names]
    cnt = [np.fromfile(find(n + ".counts"), np.float32).reshape(H, W).astype(np.float64) for n in names]
    exact = all(int(round(c.sum())) == m["tally"]["landed"] for c, m in zip(cnt, ms))
    f = figure(1800, 900, 9, "Trillion kernel: exact counts, and the stochastic splat is unbiased",
               f"src/trillion TrillionKernel on its demo page's scene and stand-in laws, {ms[0]['n']:,.0f} particles, {ms[0]['planes']} sheets, {W}x{H}, CountToneMapper  |  owner: Build the trillion-particle splat kernel",
               "ok", need)
    crop = (slice(150, 330), slice(150, 470))
    paste(f, ims[0], 30, 150, 560, label="point splat")
    paste(f, ims[1], 620, 150, 560, label="stochastic bilinear splat (default)")
    d = np.abs(ims[1] - ims[2])
    paste(f, heat(d, 16), 1210, 150, 560, label="stochastic, salt 0 vs salt 1, same instant")
    paste(f, ims[0][crop], 30, 520, 560, nearest=True, border=AMBER, label="point, 1.75x zoom")
    paste(f, ims[1][crop], 620, 520, 560, nearest=True, border=GREEN, label="stochastic, same pixels")

    bp, bs = gauss_blur(cnt[0]), gauss_blur(cnt[1])
    rel = float(np.median((np.abs(bp - bs) / (bp + bs + 1e-9) * 2)[(bp + bs) > 10]))
    lit = cnt[1] > 0
    selftest = sibling(names[0] + ".rgba", "results.json").get("trillion", {}).get("selftest")
    t = ms[0]["tally"]
    text_block(f, 1210, 520, [
        "Checked:",
        f"- Exact: in all three frames the counter sum equals the landed tally ({ms[0]['tally']['landed']:,} of {ms[0]['tally']['evaluated']:,} evaluated){'' if exact else ' (MISMATCH)'}.",
        f"- The demo's self test: {'passed' if selftest and selftest.get('ok') else 'not run' if not selftest else 'FAILED'}; two batch plans give bit-identical counters." if selftest is not None else "- Self test result not found.",
        f"- Unbiased: after a 2 px blur, point and stochastic counts differ by a median {rel * 100:.1f}%. Coverage {(cnt[0] > 0).mean() * 100:.1f}% vs {(cnt[1] > 0).mean() * 100:.1f}%.",
        f"- Noise: a new salt at the same instant moves lit pixels by {d[lit].mean():.1f} levels on average (99th percentile {np.percentile(d, 99):.0f}). When this was rendered the offline renderer set the salt to the frame number, so a video got fresh grain every frame; PR #174 has since kept it constant. At 1T density the grain shrinks with the square root of the hits per pixel.",
        f"Not checked here: the stand-in laws never take the shared-memory tile path (patches {t.get('patches', 0)}, full tiles {t.get('tiledPatches', 0)}, partial tiles {t.get('partialPatches', 0)}), so PR #115's partial tiles are not exercised by this scene" + (". Figure 11 runs the offline laws through this kernel, but the offline renderer does not report tile use." if have("kernels-trillion-40M.gray") else ".") + " This scene also has no fine periodic structure, so it cannot show the point splat's ring moire (trillion-A in docs/record).",
    ], 560, font_=F_SMALL)
    save(f, out, "09-trillion-kernel.jpg")


def fig_kernels(out: str) -> None:
    names = ["kernels-offline-40M", "kernels-trillion-40M"]
    need = [n + ".gray" for n in names] + [n + ".codes" for n in names]
    if not have(*need):
        print("skip kernels: inputs missing")
        return
    mo, mt = meta(names[0] + ".gray"), meta(names[1] + ".gray")
    so, st = mo["stats"], mt["stats"]
    go, gt = gray(names[0]), gray(names[1])
    co, ct = codes(names[0]), codes(names[1])
    # Grid units per particle: 65536 unless the stats say otherwise (finer flux weights since PR #166).
    upp_o, upp_t = int(so.get("unitsPerParticle") or 65536), int(st.get("unitsPerParticle") or 65536)
    light_o, light_t = int(so["unitSum"]) / upp_o, int(st["unitSum"]) / upp_t
    whole = int(st["unitSum"]) % upp_t == 0
    bits_o = round(math.log2(upp_o))
    drawn_o, drawn_t = so.get("drawn"), st.get("drawn")
    pt = (2.0 ** (ct / 1024) - 1) / 65536
    lit_t = pt > 0.5
    one = float((np.round(pt[lit_t]) == 1).mean() * 100)
    landed = landed_o = int(so["landed"])
    landed_t = int(st["landed"])
    full = [r for r in flux_keep().get("rows", []) if r["particles"] >= 1e12]
    f = figure(1800, 960, 11, "The trillion kernel in the offline renderer turns flux weighting into a sparse subsample",
               f"src/offline StatelessRenderer, kernel 'offline' (default) vs 'trillion' (PR #80), trillion shot at 40M particles, frame {mo['frame']}, shutter 0, one tone table  |  owner: Build the trillion-particle splat kernel; FYI offline renderer",
               "low", need)
    paste(f, go, 30, 150, 560, label="kernel 'offline' (the film's kernel)", border=GREEN)
    paste(f, gt, 620, 150, 560, label="kernel 'trillion', same job and frame", border=AMBER)
    crop = (slice(50, 190), slice(200, 420))
    paste(f, go[crop], 30, 520, 560, nearest=True, border=GREEN, label="offline, 2.5x zoom")
    paste(f, gt[crop], 620, 520, 560, nearest=True, border=AMBER, label="trillion, same pixels")
    s = 560 / go.shape[1]
    for x in (30, 620):
        f.draw.rectangle([x + crop[1].start * s, 150 + crop[0].start * s, x + crop[1].stop * s, 150 + crop[0].stop * s], outline=CYAN, width=2)
    lines = [
        "Same light, different picture.",
        f"- Light: the trillion kernel's grid sums to {light_t:,.0f} particles, the offline kernel's to {light_o:,.0f} ({(light_t / light_o - 1) * 100:+.2f}%, {abs(light_t / light_o - 1) * math.sqrt(light_t):.1f} standard deviations of the kept count's {100 / math.sqrt(light_t):.2f}% shot noise). Its grid holds a whole number of particles in every pixel{'' if whole else ' (NOT a whole number: check)'}.",
        f"- Picture: under flux weighting the offline kernel adds every particle at weight min(1, (fluxRef / depth)^2), " + (f"in units of 2^-{bits_o} of a particle (PR #166; it was 1/65,536 before, and a particle dimmer than that added one unit or nothing at random)." if bits_o > 16 else "rounded at random in 1/65,536ths.") + f" The trillion kernel keeps each sheet's particles with that probability, taken at the sheet's centre, and adds the kept ones at full weight. Here it drew {light_t:,.0f} of the {landed_t:,} particles in frame ({light_t / landed_t * 100:.1f}%), so it lights {(ct > 0).mean() * 100:.0f}% of the frame's pixels and the offline kernel {(co > 0).mean() * 100:.0f}%, and {one:.0f}% of its lit pixels hold exactly one particle.",
    ]
    if drawn_o is not None and drawn_t is not None:
        lines.append(f"- The GPU's own drawn tally (PR #166: particles in frame that added any light) agrees: {int(drawn_t):,} of {landed_t:,} for the trillion kernel{'' if int(drawn_t) == round(light_t) else ' (not its light sum: check)'}, and {int(drawn_o):,} of {landed_o:,} for the offline kernel{', every particle in frame' if int(drawn_o) == landed_o else ''}. The label claims that every particle added light only when the two are equal.")
        if landed_o != landed_t:
            lines.append(f"- The two in-frame counts differ by {abs(landed_o - landed_t):,} ({abs(landed_o - landed_t) / landed_o * 100:.3f}%): the offline kernel tests each particle's position, the trillion kernel the pixel its splat picked, so particles on the frame's edge can fall either way.")
    if full:
        r0 = next(r for r in full if r["frame"] == 0)
        r150 = next((r for r in full if r["frame"] == 150), r0)
        px = r0["width"] * r0["height"]
        later = [r for r in full if r["frame"] > 150]
        lines.append(f"- At 1T (the real job, computed from its sheets and camera, nothing rendered): fluxRef shrinks with the count ({r0['fluxRef']:.2f} at 1T in 4K), so in the wide opening, where every sheet is in view, the kernel would keep about {r0['kept'] / 1e6:.1f} million of 1e12 particles at frame 0 and {r150['kept'] / 1e6:.1f} million at frame 150, about {r0['kept'] / px:.2f} and {r150['kept'] / px:.2f} per 4K pixel: dots, not a density field. Later frames keep more as near sheets fill the view (" + ", ".join(f"{r['share'] * 100:.0f}%" for r in later) + " of all particles, in view or not, at frames " + ", ".join(str(r["frame"]) for r in later) + ").")
    lines += [
        "- The film is not affected: docs/perf.md makes src/offline the film's 1T kernel. But 'trillion' is not a drop-in there under flux weighting, and an A/B under flux compares every particle against a few percent of them, in look and in atomics written.",
        "- Fix (suggested): run A/Bs with weighting 'count', where both kernels draw every particle. To render the film with this kernel, give it fractional weights (keep x units per particle on each hit, rounded at random, as the offline kernel does) instead of a keep probability.",
        ("Shutter 0 for both, so they differ only in how they weight light (both blur camera moves since PR #174)." if bits_o > 16 else "Shutter 0 for both: when this was rendered the trillion kernel had no camera blur (PR #174 has since added it). PRs #171 and #174 left the per-sheet keep probability as it was."),
    ]
    text_block(f, 1210, 150, lines, 560, font_=F_SMALL)
    save(f, out, "11-trillion-kernel-flux.jpg")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inputs", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    INPUTS.extend(a.inputs)
    os.makedirs(a.out, exist_ok=True)
    figs = {
        "washout": fig_washout, "supersample": fig_supersample, "mp4": fig_mp4, "label": fig_label,
        "offline": fig_offline_counts, "challenge": fig_challenge, "temporal": fig_temporal, "ramp": fig_ramp,
        "trillion": fig_trillion, "short": fig_offline_short_jobs, "kernels": fig_kernels,
    }
    for name, fn in figs.items():
        if a.only and name not in a.only:
            continue
        try:
            fn(a.out)
        except Exception as e:  # keep going: one broken figure should not hide the rest
            print(f"figure {name} failed: {e}", file=sys.stderr)
            raise


if __name__ == "__main__":
    main()
