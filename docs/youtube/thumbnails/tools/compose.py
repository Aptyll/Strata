#!/usr/bin/env python3
"""
Compose the YouTube thumbnail candidates for Strata from real renders.

    python3 docs/youtube/thumbnails/tools/compose.py --stills <dir>

<dir> is what render-stills.mjs wrote: one folder per shot (wide, hero, dive,
record-wide, record-hero, pixel, pixel-count, one), each in the offline
renderer's format: job.json, frame-000000.png (16-bit log light) and
frame-000000.json (stats). Nothing here invents particles. Every image area
is a renderer frame, graded and cropped; the only drawn elements are type,
a loupe outline and the magnified single particle (from the "one" shot).

Writes into docs/youtube/thumbnails/ (or --out):
    candidates/NN-name.jpg   1280 x 720 thumbnails, JPEG under 2 MB
    contact-sheet.jpg        all candidates side by side
    feed-dark.jpg            each candidate at 480, 320 and 168 px wide on
    feed-light.jpg           YouTube's dark (#0F0F0F) and light backgrounds,
                             next to colourful stand-ins for other videos
    manifest.json            sources, particle counts, brightness per candidate

Needs Python 3.9+, numpy and Pillow (with raqm for tabular figures; it falls
back to the default shaping without it).
"""
from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, features

HERE = Path(__file__).resolve().parent
LAB = HERE.parent
FONT = LAB / "fonts" / "InterDisplay-Black.otf"

W, H = 1280, 720          # YouTube thumbnail size
SS = 4                    # supersampling for type and lines
ONE = 65536               # weight units per particle, as in src/offline/core/job.ts
LOG_SCALE = 1024          # codes per stop, as in src/offline/core/develop.ts
DARK_FEED = (15, 15, 15)  # YouTube dark mode background, #0F0F0F
LIGHT_FEED = (255, 255, 255)
BADGE = (W - 170, H - 70)  # keep type out of the duration badge, bottom right

# ------------------------------------------------------------------ stills --


@dataclass
class Still:
    """One rendered frame: light per pixel in particles (flux weighted) plus its records."""

    name: str
    light: np.ndarray  # float64, H x W, particles per pixel
    job: dict
    stats: dict

    @property
    def particles(self) -> int:
        return sum(p["particleCount"] for p in self.job["planes"])

    @property
    def size(self) -> tuple[int, int]:
        return self.light.shape[1], self.light.shape[0]

    def describe(self) -> dict:
        d = {
            "shot": self.name,
            "clip_frame": clip_frame(self.job),
            "particles": self.particles,
            "size": f"{self.size[0]}x{self.size[1]}",
            "weighting": self.job["weighting"],
            "render_seconds": round(self.stats["seconds"], 1),
        }
        if self.stats.get("inView") is not None:
            d["in_view"] = int(self.stats["inView"])
        return d


def clip_frame(job: dict) -> int | None:
    """Which frame of the 1T clip a still is (render-stills names them frame-N)."""
    name = job.get("name", "")
    return int(name.split("-")[1]) if name.startswith("frame-") else None


def load_still(root: Path, name: str) -> Still:
    folder = root / name
    job = json.loads((folder / "job.json").read_text())
    stats = json.loads((folder / "frame-000000.json").read_text())
    codes = np.asarray(Image.open(folder / "frame-000000.png"), dtype=np.float64)
    units = np.where(codes > 0, np.exp2(codes / LOG_SCALE) - 1.0, 0.0)
    return Still(name, units / ONE, job, stats)


# ------------------------------------------------------------------- grade --


@dataclass
class Look:
    """Thumbnail grade. Same tone curve as src/offline/core/grade.ts, pushed brighter.

    white:    light that maps to full white, as a percentile of lit pixels...
    stops:    ...pushed this many stops brighter (the packaging plan allows +1 to +2)
    contrast: white / toe. Lower drops faint haze to black and makes shapes bolder.
    gamma:    > 1 deepens the mids.
    floor:    the faintest share of the curve maps to true black (black toe).
    bloom:    strength of a soft glow around the brightest light, so small
              bright structure survives being shrunk to feed size.
    """

    percentile: float = 99.5
    stops: float = 1.5
    contrast: float = 512.0
    gamma: float = 1.15
    floor: float = 0.04
    bloom: float = 0.35
    bloom_threshold: float = 0.55
    gain: float = 1.0  # final multiplier, below 1 to dim (used for the old-record inset)


def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur approximated by three box passes (summed-area tables)."""
    if sigma <= 0:
        return a
    r = max(1, int(round(math.sqrt(12 * sigma * sigma / 3 + 1) / 2)))
    out = a.astype(np.float64)
    for axis in (0, 1):
        for _ in range(3):
            pad = [(0, 0), (0, 0)]
            pad[axis] = (r + 1, r)
            c = np.cumsum(np.pad(out, pad, mode="edge"), axis=axis)
            hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
            lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
            out = (hi - lo) / (2 * r + 1)
    return out


def resample(light: np.ndarray, box: tuple[float, float, float, float], size: tuple[int, int]) -> np.ndarray:
    """Crop `box` (x0, y0, x1, y1 in source pixels) and resize to `size`, averaging light."""
    src = Image.fromarray(light.astype(np.float32), mode="F")
    shrink = (box[2] - box[0]) / size[0]
    method = Image.Resampling.BOX if shrink >= 1 else Image.Resampling.BICUBIC
    out = np.asarray(src.resize(size, method, box=box), dtype=np.float64)
    return np.maximum(out, 0.0)


def white_point(light: np.ndarray, look: Look) -> float:
    lit = light[light > 0]
    if lit.size == 0:
        return 1.0
    return float(np.percentile(lit, look.percentile)) / (2.0 ** look.stops)


def tone(light: np.ndarray, look: Look, white: float | None = None) -> np.ndarray:
    """Light in particles per pixel to display value in [0, 1]."""
    white = white_point(light, look) if white is None else white
    toe = white / look.contrast
    v = np.log1p(light / toe) / math.log1p(white / toe)
    v = np.clip((np.clip(v, 0, 1) - look.floor) / (1 - look.floor), 0, 1) ** look.gamma
    if look.bloom > 0:
        hot = np.clip(v - look.bloom_threshold, 0, None) / (1 - look.bloom_threshold)
        glow = 0.5 * blur(hot, 3) + 0.3 * blur(hot, 10) + 0.2 * blur(hot, 28)
        v = 1 - (1 - v) * (1 - np.clip(look.bloom * glow, 0, 1))  # screen blend
    return np.clip(v * look.gain, 0, 1)


def fit_box(still: Still, center: tuple[float, float], width: float, aspect: float = W / H) -> tuple[float, float, float, float]:
    """A crop of `width` source pixels at `aspect`, centred on `center`, kept inside the frame."""
    sw, sh = still.size
    width = min(width, sw, sh * aspect)
    height = width / aspect
    x0 = min(max(center[0] - width / 2, 0), sw - width)
    y0 = min(max(center[1] - height / 2, 0), sh - height)
    return (x0, y0, x0 + width, y0 + height)


def light_bbox(light: np.ndarray, keep: float = 0.98) -> tuple[float, float, float, float]:
    """Box holding `keep` of the light, trimming equal shares from each side."""
    cut = (1 - keep) / 2
    out = []
    for axis in (0, 1):
        profile = light.sum(axis=axis)
        cdf = np.cumsum(profile) / profile.sum()
        out.append((float(np.searchsorted(cdf, cut)), float(np.searchsorted(cdf, 1 - cut))))
    (x0, x1), (y0, y1) = out
    return (x0, y0, x1, y1)


# -------------------------------------------------------------------- type --


class Layer:
    """Anti-aliased white marks (type, lines, discs) drawn at SS times the size."""

    def __init__(self) -> None:
        self.im = Image.new("L", (W * SS, H * SS), 0)
        self.draw = ImageDraw.Draw(self.im)

    def font(self, px: float) -> ImageFont.FreeTypeFont:
        return ImageFont.truetype(str(FONT), max(1, int(round(px * SS))))

    def text_width(self, text: str, px: float) -> float:
        l, _, r, _ = self.draw.textbbox((0, 0), text, font=self.font(px), anchor="ls", features=FEATURES)
        return (r - l) / SS

    def fit(self, text: str, width: float, max_px: float = 400) -> float:
        """Largest size (px) at which `text` is at most `width` wide."""
        lo, hi = 4.0, max_px
        for _ in range(30):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if self.text_width(text, mid) <= width else (lo, mid)
        return lo

    def text(self, xy: tuple[float, float], text: str, px: float, anchor: str = "ls", value: int = 255) -> tuple[float, float, float, float]:
        f = self.font(px)
        p = (xy[0] * SS, xy[1] * SS)
        self.draw.text(p, text, fill=value, font=f, anchor=anchor, features=FEATURES)
        l, t, r, b = self.draw.textbbox(p, text, font=f, anchor=anchor, features=FEATURES)
        return (l / SS, t / SS, r / SS, b / SS)

    def rect(self, box: tuple[float, float, float, float], width: float, value: int = 255) -> None:
        self.draw.rectangle([c * SS for c in box], outline=value, width=max(1, int(round(width * SS))))

    def line(self, a: tuple[float, float], b: tuple[float, float], width: float, value: int = 255) -> None:
        self.draw.line([a[0] * SS, a[1] * SS, b[0] * SS, b[1] * SS], fill=value, width=max(1, int(round(width * SS))))

    def alpha(self) -> np.ndarray:
        """Coverage in [0, 1] at thumbnail size."""
        return np.asarray(self.im.resize((W, H), Image.Resampling.BOX), dtype=np.float64) / 255.0


FEATURES = ["tnum"] if features.check("raqm") else None


def knockout(img: np.ndarray, alpha: np.ndarray, radius: float, strength: float = 0.85) -> np.ndarray:
    """Darken the picture around marks so white type separates from white particles."""
    shadow = np.clip(blur(alpha, radius) * 2.2, 0, 1)
    return img * (1 - strength * shadow)


def shade(img: np.ndarray, top: float = 0.0, bottom: float = 0.0, reach: float = 0.36, depth: float = 0.6) -> np.ndarray:
    """A soft vertical vignette (a grade, like a graduated filter) to seat type at the top or bottom."""
    y = np.linspace(0, 1, img.shape[0])[:, None]
    k = np.ones_like(y)
    if top:
        k *= 1 - depth * top * np.clip(1 - y / reach, 0, 1) ** 1.5
    if bottom:
        k *= 1 - depth * bottom * np.clip(1 - (1 - y) / reach, 0, 1) ** 1.5
    return img * k


def over(img: np.ndarray, alpha: np.ndarray, value: float = 1.0) -> np.ndarray:
    return img * (1 - alpha) + value * alpha


def place(canvas: np.ndarray, part: np.ndarray, x: int, y: int) -> None:
    h, w = part.shape
    canvas[y : y + h, x : x + w] = part


# ------------------------------------------------------------- candidates --


@dataclass
class Candidate:
    slug: str
    concept: str
    words: list[str]
    sources: list[Still]
    image: np.ndarray
    notes: dict = field(default_factory=dict)


NUMBER = "1,000,000,000,000"


def c_number_world(s: dict[str, Still]) -> Candidate:
    """The whole world (frame 0, every particle in frame) under the number."""
    wide = s["wide"]
    x0, y0, x1, y1 = light_bbox(wide.light, 0.985)
    width = (x1 - x0) / 0.94
    box = fit_box(wide, ((x0 + x1) / 2, (y0 + y1) / 2 - 0.13 * width * H / W), width)
    img = tone(resample(wide.light, box, (W, H)), Look(stops=2.0, contrast=256, bloom=0.5))
    marks = Layer()
    px = marks.fit(NUMBER, W - 2 * 52)
    marks.text((W / 2, 52 + px * 0.73), NUMBER, px, anchor="ms")
    a = marks.alpha()
    return Candidate("number-world", "The number over the whole world", [NUMBER], [wide], over(knockout(img, a, 14), a),
                     {"crop_4k": [round(v) for v in box]})


def c_number_spiral(s: dict[str, Still]) -> Candidate:
    """The hero sheet's spiral, the number across the top."""
    hero = s["hero"]
    img = tone(resample(hero.light, (0, 0, *hero.size), (W, H)), Look(stops=1.5, contrast=384, bloom=0.45))
    img = shade(img, top=1.0)
    marks = Layer()
    px = marks.fit(NUMBER, W - 2 * 52)
    marks.text((W / 2, 46 + px * 0.73), NUMBER, px, anchor="ms")
    a = marks.alpha()
    return Candidate("number-spiral", "The number over the hero spiral", [NUMBER], [hero], over(knockout(img, a, 22, 0.92), a))


def c_one_vs_trillion(s: dict[str, Still]) -> Candidate:
    """Concept A: one particle labelled 1 against the whole world labelled with the number."""
    wide, one = s["wide"], s["one"]
    split, top = 400, 34
    img = np.zeros((H, W))
    x0, y0, x1, y1 = light_bbox(wide.light, 0.97)
    region_w, region_h = W - split - 14, 520
    width = max((x1 - x0) / 1.0, (y1 - y0) / 1.0 * region_w / region_h)
    box = fit_box(wide, ((x0 + x1) / 2, (y0 + y1) / 2), width, aspect=region_w / region_h)
    part = tone(resample(wide.light, box, (region_w, region_h)), Look(stops=2.5, contrast=256, bloom=0.6))
    part = part * np.clip(np.linspace(0, 1, region_w)[None, :] / 0.08, 0, 1)  # feather the left edge
    place(img, part, split, top)
    marks = Layer()
    px = marks.fit(NUMBER, region_w - 40)
    base = 628
    marks.text((split + region_w / 2, base), NUMBER, px, anchor="ms")
    marks.text((split / 2, base), "1", px, anchor="ms")
    a = marks.alpha()
    # The single particle: the only lit pixel of the "one" still, drawn as a
    # magnified point with the same glow as the rest of the picture.
    ys, xs = np.nonzero(one.light)
    dot = Layer()
    cx, cy = split / 2, top + region_h / 2
    r = 9.0
    dot.draw.ellipse([(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=255)
    d = dot.alpha()
    glow = np.clip(0.55 * blur(d, 7) + 0.45 * blur(d, 26), 0, 1)
    img = 1 - (1 - img) * (1 - np.clip(glow * 2.0, 0, 1))
    img = over(img, d)
    img = over(knockout(img, a, 12), a)
    return Candidate("one-vs-trillion", "One particle against all of them", ["1", NUMBER], [wide, one], img,
                     {"one_particle_4k_pixel": [int(xs[0]), int(ys[0])], "crop_4k": [round(v) for v in box]})


def c_record(s: dict[str, Still]) -> Candidate:
    """Concept B: the same view at Noah's old record (4,000,000) as a dim inset."""
    hero, record = s["hero"], s["record-hero"]
    img = tone(resample(hero.light, (0, 0, *hero.size), (W, H)), Look(stops=1.5, contrast=384, bloom=0.45))
    iw, ih, ix, iy = 384, 216, 44, 44
    inset = tone(resample(record.light, (0, 0, *record.size), (iw, ih)), Look(stops=0.5, contrast=256, bloom=0.0, gain=0.55))
    marks = Layer()
    px_small = 46
    small_base = iy + ih + 14 + px_small * 0.73
    marks.text((ix, small_base), "4,000,000", px_small, anchor="ls", value=215)
    px = marks.fit(NUMBER, BADGE[0] - 2 * 44)
    marks.text((44, H - 44), NUMBER, px, anchor="ls")
    a = marks.alpha()
    frame = Layer()
    frame.rect((ix - 3, iy - 3, ix + iw + 3, iy + ih + 3), 3, value=200)
    fa = frame.alpha()
    img = knockout(shade(img, bottom=0.8), np.clip(a + fa, 0, 1), 18, 0.9)
    hole = np.zeros((H, W))
    hole[iy - 3 : iy + ih + 3, ix - 3 : ix + iw + 3] = 1
    img = img * (1 - hole)
    place(img, inset, ix, iy)
    img = over(img, fa, 200 / 255)
    img = over(img, a)
    return Candidate("record-vs-new", "Old record against the new one", ["4,000,000", NUMBER], [hero, record], img)


def c_pure(s: dict[str, Still]) -> Candidate:
    """Concept C: the strongest structure, no type at all."""
    hero = s["hero"]
    sw, sh = hero.size
    box = fit_box(hero, (sw * 0.42, sh * 0.52), sw * 0.72)
    img = tone(resample(hero.light, box, (W, H)), Look(stops=1.5, contrast=384, bloom=0.5))
    return Candidate("pure-image", "The picture alone", [], [hero], img, {"crop_4k": [round(v) for v in box]})


def c_pixel(s: dict[str, Still], pixel: tuple[int, int]) -> Candidate:
    """The single-pixel idea: one pixel of the frame, opened up to show the particles inside."""
    hero, inside, counted = s["hero"], s["pixel"], s.get("pixel-count")
    img = tone(resample(hero.light, (0, 0, *hero.size), (W, H)), Look(stops=1.5, contrast=384, bloom=0.45))
    lw = 410
    lx, ly = W - 44 - lw, 44
    loupe = tone(resample(inside.light, (0, 0, *inside.size), (lw, lw)), Look(percentile=99.0, stops=0.5, contrast=64, gamma=1.0, floor=0.0, bloom=0.6, bloom_threshold=0.3))
    sx, sy = hero.size
    mx, my = (pixel[0] + 0.5) * W / sx, (pixel[1] + 0.5) * H / sy
    m = 7
    lines = Layer()
    lines.rect((mx - m, my - m, mx + m, my + m), 2.5)
    lines.line((mx - m, my - m), (lx, ly), 2)
    lines.line((mx - m, my + m), (lx, ly + lw), 2)
    la = lines.alpha()
    marks = Layer()
    marks.text((lx + lw, ly + lw + 22 + 60 * 0.73), "1 PIXEL", 60, anchor="rs")
    a = marks.alpha()
    img = knockout(img, np.clip(a + la, 0, 1), 10, 0.8)
    hole = np.zeros((H, W))
    hole[ly - 4 : ly + lw + 4, lx - 4 : lx + lw + 4] = 1
    img = knockout(img, hole, 18, 0.9) * (1 - hole)
    place(img, loupe, lx, ly)
    frame = Layer()
    frame.rect((lx - 4, ly - 4, lx + lw + 4, ly + lw + 4), 4)
    img = over(img, frame.alpha())
    img = over(over(img, la), a)
    notes = {"pixel_4k": list(pixel)}
    if counted is not None and counted.stats.get("inView") is not None:
        notes["particles_inside_pixel"] = int(counted.stats["inView"])
    srcs = [hero, inside] + ([counted] if counted is not None else [])
    return Candidate("inside-one-pixel", "Inside one pixel", ["1 PIXEL"], srcs, img, notes)


def c_cold_open(s: dict[str, Still]) -> Candidate:
    """A frame grab of the cold open: the hero frame with the on-screen counter, nothing designed on top."""
    hero = s["hero"]
    img = tone(resample(hero.light, (0, 0, *hero.size), (W, H)), Look(stops=1.5, contrast=384, bloom=0.45))
    marks = Layer()
    px = marks.fit(NUMBER, 700)
    base = H - 96
    marks.text((50, base), NUMBER, px, anchor="ls")
    marks.text((53, base + 52), "PARTICLES", 40, anchor="ls", value=225)
    a = marks.alpha()
    return Candidate("cold-open", "A frame grab of the cold open, counter included", [NUMBER, "PARTICLES"], [hero],
                     over(knockout(shade(img, bottom=0.6), a, 16, 0.9), a))


def c_trillion_word(s: dict[str, Still]) -> Candidate:
    """The same number as a word, so it reads at the smallest feed sizes."""
    hero = s["hero"]
    sw, sh = hero.size
    box = fit_box(hero, (sw * 0.45, sh * 0.56), sw * 0.86)
    img = tone(resample(hero.light, box, (W, H)), Look(stops=1.5, contrast=384, bloom=0.5))
    img = shade(img, top=1.0, reach=0.42)
    marks = Layer()
    word = "1 TRILLION"
    px = marks.fit(word, W - 2 * 70)
    marks.text((W / 2, 40 + px * 0.73), word, px, anchor="ms")
    a = marks.alpha()
    return Candidate("trillion-word", "The number as a word", [word], [hero], over(knockout(img, a, 24, 0.92), a),
                     {"crop_4k": [round(v) for v in box]})


# ----------------------------------------------------------------- outputs --


def to_rgb(img: np.ndarray) -> Image.Image:
    g = np.clip(np.round(img * 255), 0, 255).astype(np.uint8)
    return Image.fromarray(np.stack([g, g, g], axis=-1), "RGB")


def brightness(img: np.ndarray) -> dict:
    return {
        "mean": round(float(img.mean()), 3),
        "share_above_25pct": round(float((img > 0.25).mean()), 3),
        "share_above_50pct": round(float((img > 0.5).mean()), 3),
    }


def save_jpeg(im: Image.Image, path: Path) -> int:
    for q in (95, 92, 88, 84, 80):
        im.save(path, "JPEG", quality=q, optimize=True, progressive=True, subsampling=0)
        if path.stat().st_size < 2_000_000:
            return q
    return q


def rounded(im: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", (im.width * 4, im.height * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, mask.width - 1, mask.height - 1], radius * 4, fill=255)
    out = im.convert("RGBA")
    out.putalpha(mask.resize(im.size, Image.Resampling.LANCZOS))
    return out


def stand_in(size: tuple[int, int], i: int) -> Image.Image:
    """A loud, colourful placeholder for some other video in the feed."""
    rng = np.random.default_rng(1000 + i)
    w, h = size
    c1, c2 = rng.integers(40, 256, 3), rng.integers(0, 256, 3)
    t = np.linspace(0, 1, w)[None, :, None] * 0.7 + np.linspace(0, 1, h)[:, None, None] * 0.3
    arr = (c1 * (1 - t) + c2 * t).astype(np.uint8)
    im = Image.fromarray(arr, "RGB")
    d = ImageDraw.Draw(im)
    cx, cy, r = w * rng.uniform(0.25, 0.4), h * 0.55, h * 0.32
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tuple(int(v) for v in rng.integers(150, 256, 3)))
    font = ImageFont.truetype(str(FONT), max(8, h // 5))
    d.text((w * 0.55, h * 0.3), ["WOW", "100x", "NEW!", "WHY?"][i % 4], font=font, fill=(255, 255, 255), stroke_width=max(1, h // 60), stroke_fill=(0, 0, 0))
    return im


def badge(im: Image.Image) -> Image.Image:
    """Overlay a duration badge where YouTube puts one."""
    out = im.convert("RGBA")
    w, h = out.size
    font = ImageFont.truetype(str(FONT), max(7, round(h * 0.085)))
    d = ImageDraw.Draw(out, "RGBA")
    text = "12:34"
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    pad = max(2, round(h * 0.025))
    x1, y1 = w - pad * 2, h - pad * 2
    x0, y0 = x1 - (r - l) - pad * 2, y1 - (b - t) - pad * 2
    d.rounded_rectangle([x0, y0, x1, y1], radius=pad, fill=(0, 0, 0, 205))
    d.text((x0 + pad - l, y0 + pad - t), text, font=font, fill=(255, 255, 255, 255))
    return out


def feed_sheet(cands: list[Candidate], bg: tuple[int, int, int], path: Path) -> None:
    widths = (480, 320, 168)
    gap, label_h, margin = 16, 30, 28
    stand_ins = 2
    row_w = sum(w * (1 + stand_ins) + gap * (1 + stand_ins) for w in widths) + gap * 2
    row_h = round(480 * 9 / 16) + label_h + gap * 2
    sheet = Image.new("RGB", (margin * 2 + row_w, margin * 2 + row_h * len(cands)), bg)
    fg = (240, 240, 240) if sum(bg) < 300 else (20, 20, 20)
    font = ImageFont.truetype(str(FONT), 18)
    d = ImageDraw.Draw(sheet)
    for r, c in enumerate(cands):
        y = margin + r * row_h
        d.text((margin, y), f"{r + 1:02d}  {c.slug}", font=font, fill=fg)
        x = margin
        thumb = to_rgb(c.image)
        for wi, w in enumerate(widths):
            h = round(w * 9 / 16)
            tiles = [stand_in((w, h), r * 7 + wi * 3)] + [thumb.resize((w, h), Image.Resampling.LANCZOS)] + [stand_in((w, h), r * 7 + wi * 3 + 1)]
            for tile in tiles:
                t = rounded(badge(tile), 12 if w >= 300 else 8)
                sheet.paste(t, (x, y + label_h), t)
                x += w + gap
            x += gap * 2
    sheet.save(path, "JPEG", quality=90, optimize=True)


def contact_sheet(cands: list[Candidate], path: Path) -> None:
    cols, tw, th, gap, label = 2, 640, 360, 20, 34
    rows = math.ceil(len(cands) / cols)
    sheet = Image.new("RGB", (cols * tw + (cols + 1) * gap, rows * (th + label) + (rows + 1) * gap), DARK_FEED)
    d = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(str(FONT), 20)
    for i, c in enumerate(cands):
        x = gap + (i % cols) * (tw + gap)
        y = gap + (i // cols) * (th + label + gap)
        d.text((x, y + 4), f"{i + 1:02d}  {c.slug}", font=font, fill=(235, 235, 235))
        sheet.paste(to_rgb(c.image).resize((tw, th), Image.Resampling.LANCZOS), (x, y + label))
    sheet.save(path, "JPEG", quality=90, optimize=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stills", required=True, type=Path, help="folder written by render-stills.mjs")
    ap.add_argument("--out", type=Path, default=LAB, help="where candidates/ and the sheets go")
    ap.add_argument("--pixel", default="1416,1203", help="the hero-frame pixel the pixel shots looked through (x,y at 4K)")
    ap.add_argument("--only", help="comma-separated slugs to build")
    args = ap.parse_args()

    names = ["wide", "hero", "record-hero", "pixel", "pixel-count", "one"]
    stills = {n: load_still(args.stills, n) for n in names if (args.stills / n / "frame-000000.json").exists()}
    pixel = tuple(int(v) for v in args.pixel.split(","))
    builders = [
        lambda: c_number_world(stills),
        lambda: c_one_vs_trillion(stills),
        lambda: c_number_spiral(stills),
        lambda: c_record(stills),
        lambda: c_pixel(stills, pixel),
        lambda: c_cold_open(stills),
        lambda: c_pure(stills),
        lambda: c_trillion_word(stills),
    ]
    cands = []
    for build in builders:
        try:
            cands.append(build())
        except KeyError as e:
            print(f"skipped a candidate: still {e} is missing")
    if args.only:
        keep = set(args.only.split(","))
        cands = [c for c in cands if c.slug in keep]

    out_dir = args.out / "candidates"
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for i, c in enumerate(cands, 1):
        path = out_dir / f"{i:02d}-{c.slug}.jpg"
        quality = save_jpeg(to_rgb(c.image), path)
        entry = {
            "file": f"candidates/{path.name}",
            "concept": c.concept,
            "on_image_text": c.words,
            "brightness": brightness(c.image),
            "jpeg_quality": quality,
            "bytes": path.stat().st_size,
            "sources": [st.describe() for st in c.sources],
            **c.notes,
        }
        manifest.append(entry)
        b = entry["brightness"]
        print(f"{path.name}: {entry['bytes'] / 1e3:.0f} kB, mean {b['mean']:.2f}, >25% gray on {b['share_above_25pct'] * 100:.0f}% of the frame")
    if not args.only:
        contact_sheet(cands, args.out / "contact-sheet.jpg")
        feed_sheet(cands, DARK_FEED, args.out / "feed-dark.jpg")
        feed_sheet(cands, LIGHT_FEED, args.out / "feed-light.jpg")
        (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
