# proof

The committed recipes of record renders, and the manifests of published ones.
Walkthrough: [docs/proof/reproduce.md](../docs/proof/reproduce.md).

| path | what |
| --- | --- |
| `trillion-4k.json` | the record: 10^12 particles per frame on 1024 sheets, 4K, 60 fps, 600 frames, seed 1, count weighting, point splats, a fixed camera path |
| `smoke.json` | the same kind of world at 4 million particles and 640 x 360, for trying the pipeline in seconds |
| `runs/` | published manifests, one per finished render |
| `out/` | local render and verify folders (not committed) |
