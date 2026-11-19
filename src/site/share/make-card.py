#!/usr/bin/env python3
"""Builds the link preview image (the "share card") from a real record frame.

    python3 src/site/share/make-card.py            # writes strata-1t.jpg next to this file
    python3 src/site/share/make-card.py --all DIR  # also the other variants and a GitHub social preview

The card is what chat apps and social sites show when someone pastes the site's
address: 1200x630, the size Open Graph and X cards both expect. The site plugin
(src/site/plugin.mjs) publishes strata-1t.jpg under a name that contains a hash
of its bytes, so a changed card gets a new address and old cached previews
cannot stick around.

Honest counting: the picture is the frame itself, cut to the card's shape and
scaled down, and the two numbers on it repeat the frame's own label. For a frame
with a render manifest (docs/record/<name>.manifest.json, see src/manifest) the
numbers are read from the manifest each time the card is built: `evaluated` and
`landed`, both counted by the GPU. A frame without a manifest has the numbers
from its label typed in below, with a note on what they are.

Needs Python 3 with Pillow, and the Inter font (rsms.me/inter, OFL). The output
is committed, so nobody has to run this unless the card should change.
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
RECORD = os.path.join(ROOT, "docs", "record")

W, H = 1200, 630
# One entry per record frame a card can show.
#   box       the part of the 3840x2160 frame on the card. A card is 1200x630, so a strip
#             has to go: the bottom rows, which hold the renderer's own label (far too
#             small to read at card size, so the card says the same in type that survives
#             a phone), and a few columns left and right.
#   manifest  the frame's render manifest. The card's numbers are read from it.
#   evaluated, in_frame   for a frame without a manifest: the numbers on its label.
FRAMES = {
    # Composition A on 64-bit keys. Its label takes rows 1964 to 2111, and everything
    # else this box leaves out is empty black, so the picture on the card is whole.
    "trillion64-A.png": dict(box=(68, 0, 3771, 1944), manifest="trillion64-A.manifest.json"),
    # The cluster stills fill the frame, so the box cuts through a few sheets at the
    # bottom and the sides. They were rendered on 32-bit keys, before the renderer
    # counted evaluated particles on the GPU (docs/journal/rendering, page 07): "in
    # frame" is a GPU count, the trillion is the particle count of the render job.
    "trillion-key2-f0.png": dict(box=(19, 0, 3821, 1996), evaluated="1,000,000,000,000", in_frame="107,787,615,440"),
    # key1 opens the video. Two digits of its label are hidden behind a sheet, hence "about".
    "trillion-key1-f0.png": dict(box=(19, 0, 3821, 1996), evaluated="1,000,000,000,000", in_frame="ABOUT 843 BILLION"),
}

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


def numbers(frame: str) -> tuple[str, str]:
    """The two numbers a card shows for `frame`: particles evaluated, and particles that landed in the picture."""
    spec = FRAMES[frame]
    if "manifest" not in spec:
        return spec["evaluated"], spec["in_frame"]
    with open(os.path.join(RECORD, spec["manifest"]), encoding="utf-8") as f:
        manifest = json.load(f)
    tally = manifest["frames"][0]
    if manifest.get("mode") != "rendered-stateless" or tally.get("allEvaluated") is not True:
        sys.exit(f"make-card: {spec['manifest']} does not say that every particle was evaluated. Its numbers do not go on a card.")
    return f"{int(tally['evaluated']):,}", f"{int(tally['landed']):,}"


def card(frame: str, text: bool = True, scrim: bool = False) -> Image.Image:
    im = Image.open(os.path.join(RECORD, frame)).convert("L").crop(FRAMES[frame]["box"])
    im = im.resize((W, H), Image.LANCZOS).convert("RGB")
    if scrim:
        # A busy frame needs the bottom darkened for the type to read: black fading in from row 330.
        shade = Image.new("L", (1, H), 0)
        for y in range(H):
            shade.putpixel((0, y), int(215 * min(1.0, max(0.0, (y - 330) / 190.0))))
        im.paste(Image.new("RGB", (W, H), "black"), (0, 0), shade.resize((W, H)))
    draw = ImageDraw.Draw(im, "RGBA")
    tracked(draw, (60, 48), "STRATA", font("InterDisplay-Light.otf", 26), (255, 255, 255, 235), 13)
    if text:
        evaluated, in_frame = numbers(frame)
        draw.text((57, 470), evaluated, font=font("InterDisplay-ExtraBold.otf", 70), fill=(255, 255, 255, 255))
        caption = f"PARTICLES RENDERED  ·  {in_frame} IN THIS FRAME"
        tracked(draw, (60, 558), caption, font("Inter-Medium.otf", 19), (255, 255, 255, 205), 2.2)
    return im


# The card the site uses: composition A on 64-bit keys, the first frame whose two numbers
# are both GPU counts with a manifest in the repo. 98.6% of the trillion land in the
# picture, so the big number is also true of what the picture shows.
# Not docs/record/retired/trillion-A-32bit.png: on 32-bit keys the same composition held
# at most about 17.2 billion distinct particles, repeated.
SITE_CARD = dict(frame="trillion64-A.png")

VARIANTS = {
    "strata-1t": SITE_CARD,
    "strata-1t-no-text": dict(frame="trillion64-A.png", text=False),
    "strata-1t-key2": dict(frame="trillion-key2-f0.png", scrim=True),
    "strata-1t-wide": dict(frame="trillion-key1-f0.png", scrim=True),
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
