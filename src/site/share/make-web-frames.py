#!/usr/bin/env python3
"""Makes web-sized copies of record frames, for a README or a page.

    python3 src/site/share/make-web-frames.py                 # the frames the main README shows
    python3 src/site/share/make-web-frames.py trillion64-A    # one frame, by its name in docs/record
    python3 src/site/share/make-web-frames.py --format webp --width 1280 trillion-C

A record frame in docs/record is a 3840x2160 PNG of 1 to 2 MB. That is the file
to keep and to zoom into, and the wrong file to show inline: the browser
downloads all of it to draw it at a third of its size. This writes a smaller
copy to docs/record/web/<frame>-<width>.<format>. Whatever shows the copy links
it to the PNG.

The default width, 1920, is exactly half size. It stays sharp on a high-density
screen at the width a README or a page column is drawn. The default format is
JPEG because it is read everywhere a README is; the frames are grayscale, so it
is stored with one channel. Measured on trillion-key1-f0 at 1920 wide: the PNG
is 1613 kB, JPEG 282 kB, WebP 196 kB, AVIF 130 kB.

A copy is a picture of a frame, not the frame. Counts, comparisons and pixel
peeping belong to the PNG. Needs Python 3 with Pillow. The output is committed,
so nobody has to run this unless a shown frame changes.
"""
import argparse
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
RECORD = os.path.join(ROOT, "docs", "record")
OUT = os.path.join(RECORD, "web")

# The frames README.md shows inline. Change the README's frames and you change this list.
README_FRAMES = ["trillion-key1-f0", "trillion-key2-f0"]

# Quality settings that leave no visible difference from the lossless downscale
# at 100% (JPEG about 41 dB PSNR on key1, WebP about 44 dB).
SAVE = {
    "jpg": dict(format="JPEG", quality=86, progressive=True, optimize=True),
    "webp": dict(format="WEBP", quality=86, method=6),
    "avif": dict(format="AVIF", quality=60, speed=4),
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("frames", nargs="*", default=README_FRAMES, help="frame names in docs/record, without .png")
    ap.add_argument("--width", type=int, default=1920, help="width of the copy in pixels (default 1920, half size)")
    ap.add_argument("--format", choices=sorted(SAVE), default="jpg", help="jpg (default), webp or avif")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    for name in args.frames:
        source = os.path.join(RECORD, name + ".png")
        if not os.path.exists(source):
            sys.exit(f"make-web-frames: docs/record/{name}.png does not exist.")
        frame = Image.open(source)
        if args.width >= frame.width:
            sys.exit(f"make-web-frames: {name}.png is {frame.width} wide. A copy has to be smaller than its frame.")
        height = round(frame.height * args.width / frame.width)
        target = os.path.join(OUT, f"{name}-{args.width}.{args.format}")
        frame.resize((args.width, height), Image.LANCZOS).save(target, **SAVE[args.format])
        print(
            f"{os.path.relpath(target, ROOT)}  {args.width}x{height}  {os.path.getsize(target) / 1024:.0f} kB"
            f"  (the PNG is {os.path.getsize(source) / 1024:.0f} kB)"
        )


if __name__ == "__main__":
    main()
