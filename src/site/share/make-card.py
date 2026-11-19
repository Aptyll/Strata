#!/usr/bin/env python3
"""Builds the link preview image (the "share card") from a real record frame.

    python3 src/site/share/make-card.py            # writes strata-1t.jpg next to this file
    python3 src/site/share/make-card.py --all DIR  # also the other variants and a GitHub social preview

The card is what chat apps and social sites show when someone pastes the site's
address: 1200x630, the size Open Graph and X cards both expect. The site plugin
(src/site/plugin.mjs) publishes strata-1t.jpg under a name that contains a hash
of its bytes, so a changed card gets a new address and old cached previews
cannot stick around.

Honest counting: the picture is the frame itself (only empty rows and columns
are trimmed, and it is scaled down), and both numbers on it are the ones burned
into that frame's own label. "In this frame" is the GPU's count of the particles
that landed in the picture. The big number is the particle count of the render
job: every position is computed (the renderer culls nothing), but the stills in
docs/record were most likely rendered before the renderer counted evaluated
particles on the GPU, so for them it is not a GPU count (docs/journal/rendering,
page 07). Change the frame and you must change the numbers here.

Needs Python 3 with Pillow, and the Inter font (rsms.me/inter, OFL). The output
is committed, so nobody has to run this unless the card should change.
"""
import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
RECORD = os.path.join(ROOT, "docs", "record")

W, H = 1200, 630
# The renderer's own label sits in rows 2004 to 2111 of a 3840x2160 frame and is
# far too small to read at card size, so the card stops above it and says the
# same thing in type that survives a phone. 3802 x 1996 is 1200 x 630 exactly.
FRAME_BOX = (19, 0, 3821, 1996)

FONT_DIRS = ["/usr/share/fonts/opentype/inter", os.path.expanduser("~/.fonts"), "/Library/Fonts"]


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    for d in FONT_DIRS:
        path = os.path.join(d, name)
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    sys.exit(f"make-card: font {name} not found in {FONT_DIRS}. Install Inter (https://rsms.me/inter/).")


def tracked(draw: ImageDraw.ImageDraw, xy, text: str, fnt, fill, tracking: float) -> None:
    """Text with letter spacing, which Pillow does not do by itself."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + tracking


def card(frame: str, evaluated: str | None, in_frame: str | None, scrim: bool = False) -> Image.Image:
    im = Image.open(os.path.join(RECORD, frame)).convert("L").crop(FRAME_BOX)
    im = im.resize((W, H), Image.LANCZOS).convert("RGB")
    if scrim:
        # A busy frame needs the bottom darkened for the type to read: black fading in from row 330.
        shade = Image.new("L", (1, H), 0)
        for y in range(H):
            shade.putpixel((0, y), int(215 * min(1.0, max(0.0, (y - 330) / 190.0))))
        im.paste(Image.new("RGB", (W, H), "black"), (0, 0), shade.resize((W, H)))
    draw = ImageDraw.Draw(im, "RGBA")
    tracked(draw, (60, 48), "STRATA", font("InterDisplay-Light.otf", 26), (255, 255, 255, 235), 13)
    if evaluated:
        draw.text((57, 470), evaluated, font=font("InterDisplay-ExtraBold.otf", 70), fill=(255, 255, 255, 255))
        caption = "PARTICLES RENDERED" + (f"  ·  {in_frame} IN THIS FRAME" if in_frame else "")
        tracked(draw, (60, 558), caption, font("Inter-Medium.otf", 19), (255, 255, 255, 205), 2.2)
    return im


# The card the site uses. trillion-key2-f0.png: 107,787,615,440 of the 1,000,000,000,000
# evaluated particles land in the frame (docs/record/README.md). It is a cluster render,
# so its trillion particles are distinct even on the 32-bit keys it was rendered with.
# Not trillion-A.png: composition A stacked identical sheets, so on 32-bit keys it held
# at most about 17.2 billion distinct particles, repeated.
SITE_CARD = dict(frame="trillion-key2-f0.png", evaluated="1,000,000,000,000", in_frame="107,787,615,440", scrim=True)

VARIANTS = {
    "strata-1t": SITE_CARD,
    "strata-1t-no-text": dict(frame="trillion-key2-f0.png", evaluated=None, in_frame=None),
    # key1 opens the video. Two digits of its label are hidden behind a sheet, hence "about".
    "strata-1t-wide": dict(frame="trillion-key1-f0.png", evaluated="1,000,000,000,000", in_frame="ABOUT 843 BILLION", scrim=True),
}


def save(im: Image.Image, path: str) -> None:
    # Progressive, 4:4:4 (the type has hard edges), and well under the 300 kB some chat apps cap previews at.
    im.save(path, quality=88, progressive=True, optimize=True, subsampling=0)
    print(f"{os.path.relpath(path, ROOT)}  {im.width}x{im.height}  {os.path.getsize(path) / 1024:.0f} kB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--all", metavar="DIR", help="also write the other variants and the GitHub social preview into DIR")
    args = ap.parse_args()
    site_card = card(**SITE_CARD)
    save(site_card, os.path.join(HERE, "strata-1t.jpg"))
    if args.all:
        os.makedirs(args.all, exist_ok=True)
        for name, spec in VARIANTS.items():
            save(card(**spec), os.path.join(args.all, name + ".jpg"))
        # GitHub's repository social preview is 2:1. Scale the card up and trim 16 rows top and bottom.
        github = site_card.resize((1280, 672), Image.LANCZOS).crop((0, 16, 1280, 656))
        save(github, os.path.join(args.all, "github-social-preview-1280x640.jpg"))


if __name__ == "__main__":
    main()
