#!/usr/bin/env python3
"""
Compose the YouTube thumbnail candidates for Strata from real renders.

    python3 docs/youtube/thumbnails/tools/compose.py [--stills <dir>]

Every picture area is a frame of the offline renderer, re-graded and cropped:

  docs/record/*.png  the 1,000,000,000,000 particle frames rendered on Noah's
                     RTX 2070. They are 8-bit exports of a log tone curve, so
                     this script inverts that curve back to linear light
                     (exact to about 2%, see RECORDS) and grades it again for
                     the feed. The burned-in label is cropped out, never
                     painted over.
  <dir>/loupe        render-stills.mjs: the inside of one pixel of the far
                     opener at the full trillion. Without --stills the pixel
                     candidate is skipped.

The only drawn elements are type, thin outlines and the "1" dot of the
one-vs-trillion candidate, which is a symbol, not a particle (one particle is
one pixel of a 4K frame, far too small for a feed).

Writes into docs/youtube/thumbnails/ (or --out):
    candidates/NN-name.jpg   1280 x 720 thumbnails, JPEG under 2 MB
    contact-sheet.jpg        all candidates side by side
    feed-dark.jpg            each candidate at 480, 320 and 168 px wide on
    feed-light.jpg           YouTube's dark (#0F0F0F) and light backgrounds,
                             next to colourful stand-ins for other videos
    manifest.json            sources, counts and brightness per candidate

Needs Python 3.9+, numpy and Pillow (with raqm for tabular figures; it falls
back to the default shaping without it).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, features

HERE = Path(__file__).resolve().parent
LAB = HERE.parent
RECORD = LAB.parents[1] / "record"  # docs/record
FONT = LAB / "fonts" / "InterDisplay-Black.otf"

W, H = 1280, 720          # YouTube thumbnail size
SS = 4                    # supersampling for type and lines
ONE = 65536               # weight units per particle, as in src/offline/core/job.ts
LOG_SCALE = 1024          # codes per stop, as in src/offline/core/develop.ts
DARK_FEED = (15, 15, 15)  # YouTube dark mode background, #0F0F0F
LIGHT_FEED = (255, 255, 255)
# Keep type out of the duration badge, bottom right. YouTube draws it at a
# fixed size in CSS pixels, so on a 168 px sidebar thumbnail it covers about
# a fifth of the width and a sixth of the height: x > 1000, y > 590 here.
BADGE = (W - 280, H - 130)
NUMBER = "1,000,000,000,000"
FEATURES = ["tnum"] if features.check("raqm") else None

# ----------------------------------------------------------------- sources --

# The burned-in labels (src/offline/core/grade.ts drawLabel at 4K: 5x7 glyphs
# at scale 4 from x = 48, 40 px a line, ending 48 px above the bottom). Crops
# stay clear of them. The early exports have two or three lines; the exports
# made at 1e7e66e have four, each on a darkened box.
LABEL_EARLY = (0, 1990, 1500, 2160)
LABEL_1E7E66E = (0, 1950, 1680, 2160)


@dataclass(frozen=True)
class Record:
    """A record frame in docs/record, and what it may claim."""

    file: str
    sha256: str      # first 16 hex digits of the file's SHA-256
    contrast: int    # the contrast it was exported with: white / toe in src/offline/core/grade.ts
    view: str
    keys: str
    claim: str       # the wording docs/record/README.md allows for this frame
    label: tuple[int, int, int, int]
    manifest: str | None = None      # render manifest beside it (src/manifest): GPU counts, commit, job
    in_view: int | None = None       # without a manifest: particles in view, from the label
    in_view_text: str | None = None


# Only frames that hold a trillion particles without repeats belong here.
# docs/record/README.md ("Distinct particles and keys") says what each frame
# may claim, and `claim` copies it. The first renders of compositions A and B
# (docs/record/retired) stacked identical sheets on 32-bit keys, so their
# particles repeat about 58 and 7 times: never use them.
#
# The hash stops the script when a file is replaced: its contrast, counts and
# keys must then be checked again. The contrast is also checked from the file
# itself: the auto white point puts the 99.5th percentile of lit pixels one
# stop under white, which lands on code 234 at contrast 4096 and 223 at 256.
# The far opener's in-view count is not on its label (it predates that line):
# every one of its 1,000 sheets lies at least 472 px inside the frame, so all
# of the trillion is in view (see the README).
CLAIM_32BIT = ("10^12 particles rendered, not 10^12 distinct particles: the 32-bit keys give about "
               "4.3 billion distinct keys, reused on every sheet under its own transform")
RECORDS = {
    "still": Record(
        "trillion-still-f0.png", "f07d4f439f5edf71", 4096, "frame 0, the far opener: the whole cluster",
        "32-bit pcg, commit 41e853a or c42ceda", CLAIM_32BIT, LABEL_EARLY,
        in_view=1_000_000_000_000, in_view_text="all 1,000,000,000,000: every sheet lies inside the frame (no in-view line on this early label)"),
    "A": Record(
        "trillion64-A.png", "1eb87e9b0ba4c86e", 256, "close-up: spiral disc, Lissajous ribbon, ring sheet",
        "64-bit particleKey, commit 1e7e66e", "10^12 distinct keys", LABEL_1E7E66E, manifest="trillion64-A.manifest.json"),
    "B": Record(
        "trillion64-B.png", "eb7d5d4ca11094ae", 256, "a column of stacked sheets seen from the side",
        "64-bit particleKey, commit 1e7e66e", "10^12 distinct keys", LABEL_1E7E66E, manifest="trillion64-B.manifest.json"),
    "key1": Record(
        "trillion-key1-f0.png", "b13a3a229e898857", 4096, "inside the field, the shot that opens the video",
        "32-bit pcg, commit 41e853a or c42ceda", CLAIM_32BIT, LABEL_EARLY,
        in_view=843_000_000_000, in_view_text="about 843 billion (two digits of the label are hidden behind a sheet)"),
}


@dataclass
class Source:
    """One frame as linear light, plus what the manifest says about it."""

    name: str
    light: np.ndarray  # H x W; particles per pixel, or relative to the export's white
    info: dict
    label: tuple[float, float, float, float] | None = None
    in_view: int | None = None  # particles in view: a GPU tally, or all of them for the far opener (RECORDS)

    @property
    def size(self) -> tuple[int, int]:
        return self.light.shape[1], self.light.shape[0]

    def measurable(self) -> np.ndarray:
        """The light without the burned-in label, for finding where the picture is."""
        if self.label is None:
            return self.light
        out = self.light.copy()
        x0, y0, x1, y1 = (int(v) for v in self.label)
        out[y0:y1, x0:x1] = 0
        return out


def load_record(key: str) -> Source:
    rec = RECORDS[key]
    data = (RECORD / rec.file).read_bytes()
    digest = hashlib.sha256(data).hexdigest()[:16]
    if digest != rec.sha256:
        raise SystemExit(f"docs/record/{rec.file} has changed (sha256 {digest}, RECORDS has {rec.sha256}). Check its contrast, "
                         "counts and keys against docs/record/README.md, then update RECORDS.")
    v = np.asarray(Image.open(io.BytesIO(data)).convert("L"), dtype=np.float64)
    lit = v[v > 0]
    measured = float(np.percentile(lit, 99.5)) if lit.size else 0.0
    expect = {c: 255 * math.log1p(c / 2) / math.log1p(c) for c in (256, 4096)}
    if abs(measured - expect[rec.contrast]) > abs(measured - expect[256 if rec.contrast == 4096 else 4096]):
        print(f"warning: {rec.file} looks like it was exported at the other contrast (99.5th percentile {measured:.0f})")
    # Invert L = log(1 + c r) / log(1 + c), r = light / white.
    light = np.expm1(v / 255.0 * math.log1p(rec.contrast)) / rec.contrast
    info = {"file": f"docs/record/{rec.file}", "view": rec.view, "keys": rec.keys, "claim": rec.claim}
    if rec.manifest:
        m = json.loads((RECORD / rec.manifest).read_text())
        frame = m["frames"][0]
        if not frame["allEvaluated"] or int(frame["evaluated"]) != 1_000_000_000_000:
            raise SystemExit(f"docs/record/{rec.manifest}: the GPU did not count a full trillion evaluated")
        in_view = int(frame["landed"])
        info.update({
            "manifest": f"docs/record/{rec.manifest}",
            "rendered_on": f"{m['gpu']['name']}, {m['created'][:10]}",
            "particles_evaluated": f"{int(frame['evaluated']):,} (GPU count)",
            "particles_in_view": f"{in_view:,} (GPU count)",
            "weighting": m["job"]["weighting"],
        })
    else:
        in_view = rec.in_view
        info.update({
            "rendered_on": "NVIDIA GeForce RTX 2070, 2026-11-19",
            "particles_evaluated": "1,000,000,000,000 (the job's count: these early stills have no GPU count of evaluated particles)",
            "particles_in_view": rec.in_view_text,
            "weighting": "flux, most likely (docs/record/README.md)",
        })
    info["exported_contrast"] = rec.contrast
    src = Source(key, light, info, rec.label)
    src.in_view = in_view
    return src


def load_still(folder: Path) -> Source:
    """A frame written by render-stills.mjs (the offline renderer's own format)."""
    job = json.loads((folder / "job.json").read_text())
    stats = json.loads((folder / "frame-000000.json").read_text())
    codes = np.asarray(Image.open(folder / "frame-000000.png"), dtype=np.float64)
    units = np.where(codes > 0, np.exp2(codes / LOG_SCALE) - 1.0, 0.0)
    info = {
        "file": f"{folder.name}/ (render-stills.mjs)",
        "job": job["name"],
        "particles_in_world": 1_000_000_000_000 if "1,000,000,000,000" in job["name"] else None,
        "sheets_rendered": len(job["planes"]),
        "particles_evaluated": int(stats["evaluated"]),
        "particles_in_view": int(stats["landed"]),
        "weighting": job["weighting"],
        "keys": "64-bit particleKey, main at cf36c3f (byte-identical to the render at 45c2ec0)",
        "render_seconds": round(stats["seconds"], 1),
    }
    return Source(folder.name, units / ONE, info)


# ------------------------------------------------------------------- grade --


@dataclass
class Look:
    """Thumbnail grade: the tone curve of src/offline/core/grade.ts, pushed brighter.

    stops:    exposure in stops above the video's grade, whose white is the
              99.5th percentile of lit pixels plus one stop (src/offline/core/
              grade.ts DEFAULT_LOOK). The packaging plan allows +1 to +2.
    contrast: white / toe. 256 is the video's grade. Higher lifts faint light
              (more of the frame reads bright at the same exposure), lower
              drops faint haze to black.
    gamma:    > 1 deepens the mids.
    floor:    the faintest share of the curve maps to true black.
    bloom:    a soft glow around the brightest light, so fine bright structure
              survives being shrunk to feed size.
    """

    stops: float = 2.0
    contrast: float = 256.0
    gamma: float = 1.1
    floor: float = 0.03
    bloom: float = 0.35
    bloom_threshold: float = 0.55


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
    return np.maximum(np.asarray(src.resize(size, method, box=box), dtype=np.float64), 0.0)


def max_pool(light: np.ndarray, size: int) -> np.ndarray:
    """Shrink a square frame by taking each block's maximum, so single particles stay visible dots."""
    edges = np.floor(np.arange(size) * light.shape[0] / size).astype(int)
    rows = np.maximum.reduceat(light, edges, axis=0)
    return np.maximum.reduceat(rows, edges, axis=1)


def tone(light: np.ndarray, look: Look) -> np.ndarray:
    """Linear light to display value in [0, 1]."""
    lit = light[light > 0]
    white = (float(np.percentile(lit, 99.5)) if lit.size else 1.0) * 2.0 / 2.0**look.stops
    toe = white / look.contrast
    v = np.log1p(light / toe) / math.log1p(white / toe)
    v = np.clip((np.clip(v, 0, 1) - look.floor) / (1 - look.floor), 0, 1) ** look.gamma
    if look.bloom > 0:
        hot = np.clip(v - look.bloom_threshold, 0, None) / (1 - look.bloom_threshold)
        glow = 0.5 * blur(hot, 3) + 0.3 * blur(hot, 10) + 0.2 * blur(hot, 28)
        v = 1 - (1 - v) * (1 - np.clip(look.bloom * glow, 0, 1))  # screen blend
    return np.clip(v, 0, 1)


def crop(src: Source, center: tuple[float, float], width: float, aspect: float = W / H) -> tuple[float, float, float, float]:
    """A crop `width` source pixels wide at `aspect` around `center`, inside the frame and clear of the label."""
    sw, sh = src.size
    width = min(width, sw, sh * aspect)
    height = width / aspect
    x0 = min(max(center[0] - width / 2, 0), sw - width)
    y0 = min(max(center[1] - height / 2, 0), sh - height)
    box = (x0, y0, x0 + width, y0 + height)
    if src.label is None:
        return box
    lx0, ly0, lx1, ly1 = src.label
    if box[2] <= lx0 or box[0] >= lx1 or box[3] <= ly0 or box[1] >= ly1:
        return box
    right, up = lx1 - box[0], box[3] - ly0
    if right < up and box[2] + right <= sw:
        return (box[0] + right, box[1], box[2] + right, box[3])
    if box[1] - up >= 0:
        return (box[0], box[1] - up, box[2], box[3] - up)
    # Too tall to fit above the label: shrink until it does.
    height = ly0
    width = height * aspect
    x0 = min(max(center[0] - width / 2, 0), sw - width)
    return (x0, 0.0, x0 + width, height)


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

    def disc(self, center: tuple[float, float], r: float, value: int = 255) -> None:
        cx, cy = center
        self.draw.ellipse([(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=value)

    def alpha(self) -> np.ndarray:
        """Coverage in [0, 1] at thumbnail size."""
        return np.asarray(self.im.resize((W, H), Image.Resampling.BOX), dtype=np.float64) / 255.0


CAP = 0.727  # cap height of Inter Display as a share of the font size


def knockout(img: np.ndarray, alpha: np.ndarray, radius: float, strength: float = 0.85) -> np.ndarray:
    """Darken the picture around marks so white type separates from white particles."""
    shadow = np.clip(blur(alpha, radius) * 2.2, 0, 1)
    return img * (1 - strength * shadow)


def shade(img: np.ndarray, top: float = 0.0, bottom: float = 0.0, reach: float = 0.36, depth: float = 0.6) -> np.ndarray:
    """A soft vertical vignette (a graduated filter) to seat type at the top or bottom."""
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


def with_type(img: np.ndarray, marks: Layer, radius: float = 18, strength: float = 0.9) -> np.ndarray:
    a = marks.alpha()
    return over(knockout(img, a, radius, strength), a)


# ------------------------------------------------------------- candidates --


@dataclass
class Candidate:
    slug: str
    concept: str
    words: list[str]
    sources: list[Source]
    image: np.ndarray
    notes: dict = field(default_factory=dict)


def kept(src: Source, box: tuple[float, float, float, float]) -> dict:
    """How much of the frame a crop shows, as its share of the frame's light.

    The record frames are flux weighted (a near particle adds more light than
    a far one), so this is close to, not exactly, the share of the frame's
    particles in the crop. For the far opener, where a count-weighted render of
    the same view exists (render-stills.mjs --shots far), the two agree within
    0.6 points. No particle count per crop is claimed.
    """
    light = src.measurable()
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    share = float(light[y0:y1, x0:x1].sum() / light.sum())
    return {"crop_4k": [x0, y0, x1, y1], "share_of_frame_light_in_crop": round(share, 3)}


def cluster_box(src: Source, keep: float, fill: float, aspect: float = W / H, lift: float = 0.0) -> tuple[float, float, float, float]:
    """A crop in which the cluster's light box fills `fill` of the width or height, whichever binds."""
    x0, y0, x1, y1 = light_bbox(src.measurable(), keep)
    width = max((x1 - x0) / fill, (y1 - y0) / fill * aspect)
    return crop(src, ((x0 + x1) / 2, (y0 + y1) / 2 - lift * width / aspect), width, aspect)


def c_one_vs_trillion(s: dict[str, Source]) -> Candidate:
    """Plan concept A: one dot labelled 1 against the whole trillion labelled with the number."""
    still = s["still"]
    split, top = 380, 132
    region_w, region_h = W - split, H - top
    box = cluster_box(still, 0.985, 0.97, region_w / region_h)
    part = tone(resample(still.light, box, (region_w, region_h)), Look(stops=2.0, contrast=1024, gamma=1.0, bloom=0.6, bloom_threshold=0.4))
    part = part * np.clip(np.linspace(0, 1, region_w)[None, :] / 0.06, 0, 1)
    img = np.zeros((H, W))
    place(img, part, split, top)
    marks = Layer()
    px = marks.fit(NUMBER, region_w - 60)
    base = 36 + px * CAP
    marks.text((split + region_w / 2, base), NUMBER, px, anchor="ms")
    marks.text((split / 2, base), "1", px, anchor="ms")
    marks.disc((split / 2, top + region_h * 0.45), 12)
    return Candidate("one-vs-trillion", "Plan concept A: one against all of them", ["1", NUMBER], [still], with_type(img, marks, 12),
                     {**kept(still, box), "dot": "a symbol for one particle, not a render (one particle is one 4K pixel)"})


def c_number_world(s: dict[str, Source]) -> Candidate:
    """The whole trillion in one frame, the number across the top."""
    still = s["still"]
    box = cluster_box(still, 0.985, 0.94, lift=0.11)
    img = tone(resample(still.light, box, (W, H)), Look(stops=2.0, contrast=1024, gamma=1.0, bloom=0.6, bloom_threshold=0.4))
    marks = Layer()
    px = marks.fit(NUMBER, W - 2 * 50)
    marks.text((W / 2, 44 + px * CAP), NUMBER, px, anchor="ms")
    return Candidate("number-world", "The number over the whole trillion, every particle in frame", [NUMBER], [still],
                     with_type(img, marks, 14), {**kept(still, box)})


def c_number_tower(s: dict[str, Source]) -> Candidate:
    """The column of sheets, the number across its middle."""
    b = s["B"]
    x0, y0, x1, y1 = light_bbox(b.measurable(), 0.99)
    box = crop(b, ((x0 + x1) / 2, b.size[1] * 0.46), b.size[0] * 0.86)
    img = tone(resample(b.light, box, (W, H)), Look(stops=2.0, contrast=384, bloom=0.5))
    marks = Layer()
    px = marks.fit(NUMBER, W - 2 * 50)
    marks.text((W / 2, H * 0.5 + px * CAP / 2), NUMBER, px, anchor="ms")
    return Candidate("number-tower", "The number through the column of sheets", [NUMBER], [b], with_type(img, marks, 22, 0.95),
                     {**kept(b, box)})


def c_number_spiral(s: dict[str, Source]) -> Candidate:
    """The close-up of the big sheets, the number in the black under them."""
    a = s["A"]
    box = crop(a, (a.size[0] * 0.47, a.size[1] * 0.40), a.size[0] * 0.92)
    img = tone(resample(a.light, box, (W, H)), Look(stops=2.0, contrast=384, bloom=0.45))
    img = shade(img, bottom=0.8)
    marks = Layer()
    px = marks.fit(NUMBER, BADGE[0] - 46 - 16)
    marks.text((46, H - 52), NUMBER, px, anchor="ls")
    return Candidate("number-spiral", "The number under the spiral disc and the ring sheet", [NUMBER], [a], with_type(img, marks, 16),
                     {**kept(a, box)})


def c_old_record(s: dict[str, Source]) -> Candidate:
    """Plan concept B, carried by the digits: the old record and the new one at the same size."""
    a = s["A"]
    box = crop(a, (a.size[0] * 0.52, a.size[1] * 0.36), a.size[0] * 0.86)
    img = tone(resample(a.light, box, (W, H)), Look(stops=2.0, contrast=384, bloom=0.45))
    img = shade(img, bottom=1.0, reach=0.5, depth=0.75)
    marks = Layer()
    px = marks.fit(NUMBER, BADGE[0] - 46 - 16)
    gap = px * 1.18
    marks.text((46, H - 52), NUMBER, px, anchor="ls")
    l, t, r, b = marks.text((46, H - 52 - gap), "4,000,000", px, anchor="ls", value=150)
    marks.line((l - 4, (t + b) / 2), (r + 4, (t + b) / 2), px * 0.09, value=150)
    return Candidate("old-record", "Plan concept B: the old record struck through above the new one, same size", ["4,000,000", NUMBER], [a],
                     with_type(img, marks, 18), {**kept(a, box)})


def c_pixel(s: dict[str, Source]) -> Candidate:
    """The single-pixel idea: one pixel of the far opener, opened up so its particles separate."""
    still, loupe = s["still"], s["loupe"]
    pixel = loupe.info["pixel_4k"]
    lw, margin = 420, 40
    lx, ly = W - margin - lw, margin
    region_w = lx - 30
    box = cluster_box(still, 0.985, 0.92, region_w / H)
    part = tone(resample(still.light, box, (region_w, H)), Look(stops=2.0, contrast=1024, gamma=1.0, bloom=0.6, bloom_threshold=0.4))
    img = np.zeros((H, W))
    place(img, part, 0, 0)
    inside = tone(max_pool(loupe.light, lw), Look(stops=1.0, contrast=16, gamma=1.0, floor=0.0, bloom=0.5, bloom_threshold=0.3))
    scale = region_w / (box[2] - box[0])
    mx, my = (pixel[0] + 0.5 - box[0]) * scale, (pixel[1] + 0.5 - box[1]) * scale
    m = 6
    lines = Layer()
    lines.rect((mx - m, my - m, mx + m, my + m), 2.5)
    lines.line((mx + m, my - m), (lx, ly), 2)
    lines.line((mx + m, my + m), (lx, ly + lw), 2)
    marks = Layer()
    marks.text((lx + lw / 2, ly + lw + 26 + 64 * CAP), "1 PIXEL", 64, anchor="ms")
    la, a = lines.alpha(), marks.alpha()
    img = knockout(img, np.clip(la + a, 0, 1), 10, 0.8)
    hole = np.zeros((H, W))
    hole[ly - 4 : ly + lw + 4, lx - 4 : lx + lw + 4] = 1
    img = knockout(img, hole, 18, 0.9) * (1 - hole)
    place(img, inside, lx, ly)
    frame = Layer()
    frame.rect((lx - 4, ly - 4, lx + lw + 4, ly + lw + 4), 4)
    img = over(over(over(img, frame.alpha()), la), a)
    return Candidate("inside-one-pixel", "One pixel of the far opener, opened up: every dot is one particle", ["1 PIXEL"], [still, loupe], img,
                     {**kept(still, box), "pixel_4k": pixel, "particles_inside_that_pixel": loupe.info["particles_in_view"],
                      "marker": f"a {2 * m} px square around a pixel that is {scale:.2f} px wide at this size",
                      "loupe_display": f"1024 x 1024 render shrunk to {lw} px by block maximum, so every particle stays a dot"})


def c_cold_open(s: dict[str, Source]) -> Candidate:
    """A frame grab of the cold open: the opening shot with the counter, nothing designed on top."""
    k = s["key1"]
    box = crop(k, (k.size[0] / 2, k.size[1] / 2), k.size[0])
    img = tone(resample(k.light, box, (W, H)), Look(stops=2.0, contrast=384, bloom=0.45))
    img = shade(img, bottom=0.9, reach=0.42, depth=0.7)
    marks = Layer()
    px = marks.fit(NUMBER, 720)
    base = H - 100
    marks.text((48, base), NUMBER, px, anchor="ls")
    marks.text((51, base + 54), "PARTICLES", 42, anchor="ls", value=225)
    return Candidate("cold-open", "A frame grab of the opening shot, counter included", [NUMBER, "PARTICLES"], [k], with_type(img, marks, 16),
                     {**kept(k, box)})


def c_pure(s: dict[str, Source]) -> Candidate:
    """Plan concept C: the most striking structure, no type at all."""
    b = s["B"]
    x0, y0, x1, y1 = light_bbox(b.measurable(), 0.99)
    box = crop(b, ((x0 + x1) / 2, b.size[1] * 0.36), b.size[0] * 0.48)
    img = tone(resample(b.light, box, (W, H)), Look(stops=2.0, contrast=384, bloom=0.5))
    return Candidate("pure-image", "Plan concept C: the column of sheets alone", [], [b], img, {**kept(b, box)})


def c_trillion_word(s: dict[str, Source]) -> Candidate:
    """The number as a word, the largest type that fits, for the smallest feed sizes."""
    a = s["A"]
    box = crop(a, (a.size[0] * 0.45, a.size[1] * 0.50), a.size[0] * 0.84)
    img = tone(resample(a.light, box, (W, H)), Look(stops=2.0, contrast=384, bloom=0.5))
    img = shade(img, top=1.0, reach=0.45)
    marks = Layer()
    word = "1 TRILLION"
    px = marks.fit(word, W - 2 * 64)
    marks.text((W / 2, 40 + px * CAP), word, px, anchor="ms")
    return Candidate("trillion-word", "The number as a word", [word], [a], with_type(img, marks, 24, 0.92), {**kept(a, box)})


BUILDERS = [
    c_number_world,
    c_number_spiral,
    c_number_tower,
    c_one_vs_trillion,
    c_old_record,
    c_pixel,
    c_cold_open,
    c_pure,
    c_trillion_word,
]

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
    im = Image.fromarray((c1 * (1 - t) + c2 * t).astype(np.uint8), "RGB")
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
            tiles = [stand_in((w, h), r * 7 + wi * 3), thumb.resize((w, h), Image.Resampling.LANCZOS), stand_in((w, h), r * 7 + wi * 3 + 1)]
            for tile in tiles:
                t = rounded(badge(tile), 12 if w >= 300 else 8)
                sheet.paste(t, (x, y + label_h), t)
                x += w + gap
            x += gap * 2
    sheet.save(path, "JPEG", quality=90, optimize=True)


def contact_sheet(cands: list[Candidate], path: Path) -> None:
    cols, tw, th, gap, label = 3, 640, 360, 20, 34
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
    ap.add_argument("--stills", type=Path, default=LAB / "stills", help="folder written by render-stills.mjs (default: the loupe kept in stills/)")
    ap.add_argument("--out", type=Path, default=LAB, help="where candidates/ and the sheets go")
    ap.add_argument("--only", help="comma-separated slugs to build (skips the sheets and the manifest)")
    args = ap.parse_args()

    sources = {k: load_record(k) for k in RECORDS}
    if args.stills and (args.stills / "loupe" / "frame-000000.json").exists():
        loupe = load_still(args.stills / "loupe")
        found = re.search(r"loupe (\d+),(\d+)", loupe.info["job"])
        if found:
            loupe.info["pixel_4k"] = [int(found.group(1)), int(found.group(2))]
            sources["loupe"] = loupe

    keep = set(args.only.split(",")) if args.only else None
    cands = []
    for build in BUILDERS:
        try:
            c = build(sources)
        except KeyError as e:
            print(f"skipped {build.__name__}: source {e} is missing")
            continue
        if keep is None or c.slug in keep:
            cands.append(c)

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
            "sources": [src.info for src in c.sources],
            **c.notes,
        }
        manifest.append(entry)
        b = entry["brightness"]
        print(f"{path.name}: {entry['bytes'] / 1e3:.0f} kB, mean {b['mean']:.2f}, >25% gray on {b['share_above_25pct'] * 100:.0f}% of the frame")
    if keep is None:
        contact_sheet(cands, args.out / "contact-sheet.jpg")
        feed_sheet(cands, DARK_FEED, args.out / "feed-dark.jpg")
        feed_sheet(cands, LIGHT_FEED, args.out / "feed-light.jpg")
        (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
