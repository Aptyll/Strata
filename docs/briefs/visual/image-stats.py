import sys
import numpy as np
from PIL import Image

def stats(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    lum = a.mean(axis=2)
    h, w = lum.shape
    chroma = np.abs(a[..., 0] - a[..., 1]).max() + np.abs(a[..., 1] - a[..., 2]).max()
    lit = lum > 8
    out = {
        "size": f"{w}x{h}",
        "mean": round(float(lum.mean()), 1),
        "p50_lit": round(float(np.percentile(lum[lit], 50)), 1) if lit.any() else 0,
        "p95_lit": round(float(np.percentile(lum[lit], 95)), 1) if lit.any() else 0,
        "black<8": f"{(lum < 8).mean() * 100:.1f}%",
        "sat>=250": f"{(lum >= 250).mean() * 100:.2f}%",
        "sat_of_lit": f"{((lum >= 250) & lit).sum() / max(1, lit.sum()) * 100:.2f}%",
        "maxchroma": float(chroma),
        "distinct_levels": int(len(np.unique(lum.astype(np.uint8)))),
    }
    return out

for p in sys.argv[1:]:
    print(p.split("/")[-1], stats(p))
