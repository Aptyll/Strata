# Video script: "I gave 50 AI agents one hour to render a trillion particles"

A 6 to 7 minute behind-the-scenes video, narrated in the first person by the
project's director. About 1,050 words of voiceover at roughly 155 words per
minute. Every number below comes from
[how-it-was-built.md](how-it-was-built.md); check the bracketed placeholders
against the real results before recording.

**Before you record**

- Blur personal details in every screen recording: machine names, local
  folder paths, email addresses.
- Fill in bracketed lines only with numbers measured on the RTX 2070. The
  first trillion still is confirmed: 28.9 seconds, exactly 10^12 particles
  evaluated (with flux weighting, frames took 26 to 52 seconds when the sheets
  covered part of the frame and 172 to 205 seconds when they filled it;
  count-weighted frames take about 160 to 193 seconds).
- Say "rendered", never "simulated", for the trillion. The simulated tiers are
  the 100 million and 1 billion runs.

---

## 0:00 Cold open (20 s)

**B-roll:** pure black screen. One white pixel in the center. Hold two seconds.
Then a slow, continuous zoom out as the pixel resolves into a sheet of
particles, then hundreds of sheets.

**VO:**
> This is one particle. A few months ago, my personal record was four million of
> them. Tonight I asked a team of AI agents for a trillion. Two hundred and fifty
> thousand times more. And I gave them under an hour.

**On screen:** `4,000,000` counts up and morphs into `1,000,000,000,000`.

**Title card:** STRATA

## 0:20 The rules (40 s)

**B-roll:** the project chat scrolling from the first message at 6:54 PM. The
thread list filling up, one row every few seconds. A clock in the corner
running from 6:54 PM.

**VO:**
> Here was the setup. I don't write any code. I talk to one AI, the coordinator,
> and it starts other AI agents, each with its own computer, its own copy of the
> code and one job. I made an empty GitHub repo at 6:55. By 6:59 there were
> thirteen agents: one building the engine, others on the camera, the HUD,
> rendering, depth, the world, video capture. By the end of the night there
> were more than fifty.

**On screen:** `6:55 PM empty repo` then `6:59 PM 13 agents`.

## 1:00 Contracts first (50 s)

**B-roll:** `src/core/contracts.ts` scrolling. PR #1 on GitHub. A simple
animated diagram of the frame graph: simulate, interplane, rasterize, depth,
tonemap, ui, capture, with agents plugging boxes into slots.

**VO:**
> Thirteen agents writing code for a codebase that doesn't exist yet is a
> recipe for thirteen different apps. So I asked the coordinator to think like a
> lead architect. Twenty-two seconds later it came back with a plan: before
> anyone ships a feature, publish the contract. A handful of shared interfaces
> that every agent builds against, and nothing else.
>
> The engine agent already had a working engine. Instead of merging it, it
> pulled out just the interfaces and merged those first, at 7:05. The engine
> itself landed seven minutes later. Rule two: add new files, never edit shared
> ones. Features register themselves by filename, so agents almost never touch
> the same file.

**On screen:** `7:05 PM contracts` and `7:12 PM engine`.

## 1:50 The trillion problem (60 s)

**B-roll:** the Rendering Field Guide explainer's memory-wall figure. A GPU
memory bar labeled 8 GB next to a bar labeled 16 TB that runs off the screen.
Then an animation of a single index number flowing through a formula into one
pixel and vanishing.

**VO:**
> At 7:07 I said: make the goal a trillion. The coordinator agreed, and in the
> same breath told me why that's impossible the normal way. A simulation stores
> every particle. A trillion particles at sixteen bytes each is sixteen
> terabytes. My graphics card has eight gigabytes. That's two thousand times too
> small.
>
> The way through is called stateless. Nothing is stored. Each particle is just
> a number, and its position is a formula of that number and time. To draw a
> frame, the GPU computes a trillion positions, adds a speck of light for each
> one, and forgets them all. Memory stops being the limit. Time becomes the
> limit.
>
> And there's a catch I want to be upfront about: stateless particles can't
> react to each other. The motion is choreographed by physics formulas, not
> emergent. So the trillion is rendered, not simulated.

**On screen:** `position = f(index, seed, time)` and the label
`STATELESS: closed-form motion`.

## 2:50 "I don't see any progress" (40 s)

**B-roll:** the actual chat message at 7:10 PM, typos included. Then the
GitHub PR list refreshing. Then the first frame of the app: white particle
sheets in the black void.

**VO:**
> Sixteen minutes in, I typed: what are the blockers? Everything says working,
> but I don't see any progress. Nothing was blocked. Five pieces had already
> merged. But there was no engine yet, so there was nothing to open. That's the
> strange thing about parallel work: lots of finished parts and no visible
> whole. Two minutes later the engine landed, and by 7:16 the app was worth
> opening.

**On screen:** `7:10 PM "i don't see any progress"` then `7:16 PM first real app`.

## 3:30 Speed, and the crash (50 s)

**B-roll:** a fast scroll through all 41 merged PRs with their timestamps. Then
the build error in red: `Cannot find name 'now'`. Then the one-line diff of PR
#32.

**VO:**
> Then I made the riskiest call of the night: skip the long tests, just type
> check, build and merge. We'll test at the end. Forty-one pull requests merged
> in twenty-two minutes. The longest one was open for fifty-one seconds. Half of
> them, under ten. By 7:36 it was fifty-four.
>
> And yes, it broke. Two agents merged twenty-four seconds apart. Each change
> was fine on its own. Together, one of them used a variable the other had just
> moved. The whole app crashed on every frame. A third agent, the one whose only
> job was integration, caught it and shipped a one-line fix. Main was broken for
> ninety-three seconds.

**On screen:** `41 PRs / 22 min` then `broken for 93 s, fixed in 1 line`.

## 4:20 The critics (45 s)

**B-roll:** the five reflection threads in the thread list. Annotated
screenshots from the visual QA agents. A slow push-in on the summary line
"the bottleneck is proof, not headcount."

**VO:**
> Around 7:20 I added agents that weren't allowed to write code. An architect,
> an artist, a skeptic, a first-time viewer and a strategist. Three of them
> independently said the same thing: the bottleneck is proof, not headcount.
> There was no trillion code on main yet, and not a single performance number
> from a real GPU.
>
> The skeptic caught a real trap: done the lazy way, the random numbers repeat
> after about four billion particles, so a "trillion" would just be the same
> four billion copied more than two hundred times. The artist gave me the ending of this
> video. You'll see it.

**On screen:** `4.29 billion distinct particles, repeated 233 times, is not a trillion`.

## 5:05 The renderer lands (45 s)

**B-roll:** PR #41 on GitHub. Code from `src/offline/` showing the 64-bit atomic
add. A terminal on the desktop with the RTX 2070 running
`npx tsx node/cli.mjs bench`.

**VO:**
> At 7:27, thirty-three minutes after my first message, the trillion-particle
> renderer merged. It solves real equations of motion: orbits, shear flows,
> oscillators. In the proof shots every particle in view adds exactly one unit of light to a 64-bit counter,
> so the frame itself proves the count: add up every pixel and you get exactly
> how many particles are in view.
>
> Every agent so far had been running on emulated graphics. Only one agent had
> my actual GPU, an RTX 2070 from 2018.

**On screen:** `7:27 PM trillion renderer on main` and `1 real GPU`.

## 5:50 The real test (35 s)

**B-roll:** the RTX 2070 table from `docs/perf.md`, then the first
trillion-particle 4K still, then a pixel loupe zooming until single particles
separate.

**VO:**
> At 7:31 the first real numbers came in from my card. A hundred million
> particles, every one simulated and drawn every frame, at a hundred and eleven
> frames per second. Eight hundred million at fifteen. My old record was four
> million.
>
> Three minutes later, my card finished its first trillion-particle 4K frame.
> Twenty-nine seconds. And the counter on the GPU says it evaluated exactly one
> trillion particles, not one fewer. At 4K, that's about a hundred and twenty
> thousand particles per pixel, on average. This is it.
>
> `[If the trillion clip finished: "And here it is, moving." If not: "The moving
> version is still rendering. I'll pin it in the comments."]`

**On screen:** `100M @ 111 fps` then `800M @ 15 fps` then
`1,000,000,000,000 particles, one frame`.

## 6:25 What I learned (30 s)

**B-roll:** the full git timeline as a single animated strip, 41 ticks from
7:05 to 7:27. The decision cards I tapped.

**VO:**
> I didn't write a line of code. I typed thirty-nine messages and tapped four
> buttons. `[update these two counts if more came after 7:28 PM]` What made it work wasn't more agents. It was the contract first, a
> rule that keeps agents out of each other's files, one agent whose only job is
> to hold the whole thing together, and critics who aren't allowed to code.

## 6:55 Ending (15 s)

**B-roll:** the artist's idea. Every particle collapses inward until the whole
frame is a single white pixel, identical to the opening shot. Hold. Cut to
black.

**VO:**
> A trillion particles. And all of them fit back into one pixel.

**End card:** repo link, "Code and every pull request are public" (only if the
repository is public by then), and the measured numbers.

---

## Extra B-roll worth capturing

- The thread list at its busiest, with titles readable (they tell the story on
  their own).
- The GitHub "Insights > Network" or commit graph for the evening.
- The skeptic's findings and the "rendered, not simulated" wording.
- Side by side: a cloud agent's offscreen readback image and the same scene on
  the RTX 2070.
- The decision cards, full screen, with the tap.
