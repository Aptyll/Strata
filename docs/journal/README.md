# Journal

A dated record of the work on Strata: what was built, which pull requests
carried it, what was measured and on which machine, and pictures of the result.
It is written for someone who was not there, and it only reports what the
record shows. Reference docs say how things work today; the journal says what
happened and when.

| journal | what it covers |
| --- | --- |
| [rendering/](rendering/README.md) | the density look, the compute rasterizer and perf path, depth cues, the offline stateless renderer, 64-bit particle keys, the trillion kernel, proof shots, and the 1 trillion particle frames from the RTX 2070 |
| `app-ux/` (being written, lands in its own pull request) | contracts and engine, the app shell, camera, HUD and Esc menu, dice, first-run experience, world, behaviors, challenge mode, deploy |
| `media/` (being written, lands in its own pull request) | capture (PNG and MP4), recorded clips and GIFs, the scale ladder video, the story, the video plan and packaging |

## Conventions

So that the three journals read as one:

- **One folder per area**, each with a `README.md` index (what the journal
  covers, a timeline, the list of pages) and an `images/` folder.
- **Pages are dated and numbered**: `YYYY-MM-DD-NN-topic.md`. The date is
  Noah's local date (US Central). `NN` orders the pages of one day. Later work
  gets new pages; old pages are not rewritten, only corrected.
- **Times are US Central**, with UTC in brackets where it helps. The whole
  first build happened on the evening of Nov 18, 2026 Central, which is already
  Nov 19 in UTC. Other docs in this repo that say 2026-11-19 mean that same
  evening.
- **Every page says** what was built, the pull requests (number, link, merge
  time, state), the measured numbers with their source and machine, what was
  checked and what was not, and what was still open when the page was written.
- **Numbers are labelled.** Measured on the RTX 2070, measured on a software
  GPU (SwiftShader, says nothing about speed), arithmetic, or estimate. A count
  is only quoted when it came from a GPU tally or a burned-in label.
- **Simulated and rendered are kept apart.** The realtime tiers are simulated.
  The trillion is rendered (stateless), never "simulated".
- **Images in git are small copies** (about 1280 px wide, or a 100% crop).
  Each one links to its full-size original. Originals that are not in git live
  in the project's shared files folder (`/mnt/project-files/` for agents, the
  project Library for Noah) and are named by that path.
