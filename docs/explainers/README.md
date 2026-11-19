# Explainers

Learner-friendly pages that explain the computer science, math and physics behind Strata.

| File | What it covers |
| --- | --- |
| `rendering.html` | Rendering field guide: one particle's trip to a pixel, perspective, stateless motion, the memory wall, render pipeline vs compute rasterizer, atomics and counter precision, density and shot noise, tone mapping, render time. |

## Viewing

Open `rendering.html` in any browser. It is one self-contained file (inline CSS and JS, fonts from Google Fonts with system fallbacks). It has no `<html>` wrapper because it is also published as a Claude artifact, which adds one.

## Keeping it honest

- Figures quote project code by file name. If a contract changes (particle size, HDR format, pass order), update the matching figure.
- Speed numbers are estimates until `src/perf` measures them. Replace the default in the render time calculator when a measured figure exists.
- Style: white on black only, plain language, no jargon without a definition.
