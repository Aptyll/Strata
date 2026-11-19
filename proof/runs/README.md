# Published record manifests

Manifests of finished record renders go here, one file per render, named
`<date>-<gpu>.json` (for example `2026-11-20-rtx2070.json`). Each is the
`manifest.json` that `npm run record -- make` wrote, committed unchanged, with
the master MP4 attached to a GitHub release (its SHA-256 is in the manifest).

None yet: the record has not been rendered on real hardware. To check one, see
[docs/proof/reproduce.md](../../docs/proof/reproduce.md):

```sh
npm run record -- verify proof/runs/<manifest>.json
```
