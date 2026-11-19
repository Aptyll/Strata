# Sound: a generative soundtrack from the scene

`src/audio/` plays a quiet ambient soundtrack that follows what is on screen:
how many particles are drawn, how dense the frame looks, where the camera is
and how it moves, and the dice. It runs live in the app (off until you turn it
on) and renders offline, in step with fixed-step video frames, so a video
rendered from the app can carry it.

Restraint is the brief. No beat, no melody, nothing that asks for attention:
a drone that grows with the count, a breath of air when the camera moves,
rare high glints for single particles, one bell when the dice is rolled.

Hear it without a GPU: `npm run dev`, open `/src/audio/demo/`, press
**sound off** to turn it on, and move the sliders. **render 60 s climb as
wav** renders the 1 million to 1 trillion climb offline.

## What drives what

| scene | sound |
| --- | --- |
| particles drawn (log10) | how many drone voices sound. The bass is always there; voices enter around 10^4, 10^5, 10^6, 10^7.5, 10^9, 10^10.5 and 10^11.75, so the full chord only arrives near a trillion. The first time the count passes each power of ten from a million, a soft low bell rings. |
| density (particles per covered pixel, log) | the drone's low-pass opens (300 Hz to 8 kHz) and the air band rises: denser frames sound brighter. |
| fill (share of the frame covered by sheets) | wider stereo image, more frequent glints, a little more air. |
| camera yaw | every voice sits at an angle in the world, so orbiting moves voices across the speakers. |
| camera speed (orbit and zoom) | a breath of air (filtered noise) rises while the camera moves. A jump bigger than a cut (0.6 rad or a factor of 2.2 in distance in one frame) moves the stereo field but makes no wind. |
| camera distance | further out, more reverb. |
| dice roll | the drone dissolves into another chord over about four seconds (the visual roll takes 2.4 s), and one bell rings. |

Harmony: everything is a just ratio of D2 (73.4 Hz). Six chords, all diatonic
to D with F and Bb borrowed from D minor, so any chord can dissolve into any
other: open fifths (the opening), G add9, D six-nine, A sus4, F major 7 and
Bb major 7. A roll never repeats the current chord. Each voice is two
oscillators detuned by 0.07 to 0.27 Hz for a slow shimmer, and each voice
breathes on its own 14 to 40 second cycle.

Every random choice comes from the seed (the scene's seed in the app), so the
same frames and rolls always give the same soundtrack.

## In the app

- **M** or **sound** in the Esc menu turns it on and off. It is off on every
  load and the switch is never saved as on, so the site never starts making
  noise by itself. **volume** is in the same menu section and is remembered.
- Until it is first turned on there is no audio context. While it is off it
  does no work per frame and the context is suspended.
- The tab going to the background silences it and suspends the audio context.
- Only realtime frames drive the live sound. While capture or the record job
  has the GPU, it holds its last chord and levels.

Wiring, in `src/main.ts` (M is the `sound` row of `KEYS` in `src/app/keys.ts`):

```ts
const sound = mountSound({ app, hud: ui.hud, viewport: () => ({ width: graph.width, height: graph.height }), key: KEYS.sound });
loop.hooks.push({ afterFrame: (f) => sound.frame(f) }); // by afterFrame each plane's activeCount is set
```

## Offline, in step with video

Frame `i` of a video is shown at `i / fps`; on the audio timeline the same
frame's sound starts at `i / fps` too. The default sample rate is 48 kHz,
which divides evenly by 24, 25, 30, 50 and 60 fps, so every video frame starts
on a whole sample and a soundtrack is exactly `frames / fps` seconds long.

The pipeline is two steps:

1. **Compose** (`SoundPerformance`, pure TypeScript). One `SoundFrame` per
   video frame goes in; out come one value per frame for every control, plus
   the notes and chord changes with their times. It can grow a frame at a time.
2. **Render** (`renderRange`, `OfflineAudioContext`). The same Web Audio graph
   as the live sound, with every control as a value curve (linear between
   frames) and every note scheduled at its time.

Long soundtracks render in chunks. Each chunk first renders 10 seconds before
its start and throws them away, so the reverb tail, the filters and ringing
bells are where one long render would have them, while voice phases and the
noise loop are set from absolute time. Measured in headless Chromium: a 40 s
render cut into 7 s chunks differs from the one-piece render by at most
0.00002 (-93 dBFS). Rendering ran at about 7x realtime there; it has not been
timed on Noah's PC.

Level: the 60 s climb measures -18 LUFS integrated with peaks at -7 dBFS.
`normalizeLoudness` can push a WAV toward another target.

### Into the MP4

`createRecordingAudio(perf)` returns a `RecordingAudio`: after each video
frame the recorder asks it for audio up to the video time, and it hands over
8 second chunks about 10 seconds behind the video (the last 2 seconds are held
back so the end can fade out). The muxer only holds that much video in memory
waiting for audio, so streaming a long 4K render to disk still works. When the
recording stops, `finish(duration)` returns the rest, faded out, ending
exactly at the last video frame.

In the app, `sound.recordingAudio(fps)` opens one for an offline video
rendered while the sound is on: every frame rendered until the recording
finishes or is cancelled goes into it, and the live sound fades out
meanwhile. Teaching `src/capture` to take it (`RecordingOptions.audio`, an AAC
track, Opus where the browser cannot encode AAC) is a separate small change;
until that lands, videos from the app are silent.

### Scripted videos (the trillion clips)

When the camera path and the counts are known in advance, build the whole
score first:

```ts
import { scoreFromTimeline, compose, createRecordingAudio, densityOf, renderScore, encodeWav } from '../audio';

const score = scoreFromTimeline({
  fps: job.fps,
  duration: job.frames / job.fps,
  particles: () => 1e12,
  camera: (t) => path.at(t / duration),          // anything with yaw, pitch, distance
  density: (t) => densityOf(landed(t) / pixels), // optional: from the per-frame stats
  events: [{ type: 'accent', time: 12 }],
});
// Either mux while encoding with src/capture (once it takes `audio`) ...
const recording = { output, audio: createRecordingAudio(compose(score)) };
// ... or write a WAV and mux with ffmpeg:
const wav = encodeWav(await renderScore(score));  // 24-bit PCM
// ffmpeg -i video.mp4 -i soundtrack.wav -c:v copy -c:a aac -b:a 192k -shortest out.mp4
```

A score is plain JSON (`SoundScore`: `version: 1`, `fps`, `seed`, `frames`,
`events` with a `frame` each). The demo page's **render a score .json as wav**
renders one, which is the path for the Node CLI: write the score next to the
frames, render the WAV in the browser, mux with ffmpeg.

## Files

| file | what |
| --- | --- |
| `types.ts` | `SoundFrame`, `SoundEvent`, `SoundScore`, `RecordingAudio` |
| `harmony.ts` | root, chords, voice entry points and weights |
| `composer.ts` | the mapping from scene to music; pure and seeded |
| `performance.ts` | `SoundPerformance`: composed controls, notes and chords, frame by frame |
| `assets.ts` | wavetable, noise loop and reverb impulse, generated from fixed seeds |
| `graph.ts` | the Web Audio graph, shared by live and offline |
| `live.ts` | `createSoundtrack`: the live engine |
| `offline.ts` | `renderRange`, `renderPerformance`, `renderScore`, `createRecordingAudio` |
| `timeline.ts` | `scoreFromTimeline`, `ladderScore` |
| `sense.ts` | `senseScene`: a `SoundFrame` from the engine's planes and camera |
| `wav.ts`, `loudness.ts` | WAV encoding, BS.1770 loudness |
| `app.ts` | `mountSound`: menu switch, M key, dice, capture hand-off |
| `demo/` | the standalone page |

Checks: `npm test -- audio` (composer determinism, chord timing,
WAV header, loudness reference; well under a second).

## Not verified yet

Nobody has listened to it on real speakers: levels and seams were measured,
the sound itself was not judged. Live playback has not run on Noah's PC, and
the app wiring (M, the menu switch, the dice) was type checked and built but
not clicked through, since the cloud sandbox cannot run the WebGPU app. The
voice entry points and the brightness range were set by reasoning, not by ear,
and are the first things to tune (`harmony.ts`, `composer.ts`).
