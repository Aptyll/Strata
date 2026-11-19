/**
 * The harmony: one home pitch, a small palette of chords, and the order in
 * which drone voices enter as the particle count grows.
 *
 * Every frequency is a just ratio of ROOT_HZ, so voices beat only where the
 * detuning puts beats on purpose. All chords are diatonic to D (with F and Bb
 * borrowed from D minor), so any chord can dissolve into any other.
 */
import { VOICES } from "./types";

/** D2. */
export const ROOT_HZ = 73.416;

export interface Chord {
  name: string;
  /** One ratio to ROOT_HZ per drone voice, low to high. */
  ratios: readonly number[];
}

/** Chord 0 opens every performance. A dice roll moves to any other one. */
export const CHORDS: readonly Chord[] = [
  // D2 D3 A3 D4 E4 A4 E5 A5: open fifths with a ninth, no third. The void.
  { name: "open", ratios: [1, 2, 3, 4, 9 / 2, 6, 9, 12] },
  // G2 G3 D4 G4 A4 D5 G5 A5: G with an added ninth.
  { name: "lifted", ratios: [4 / 3, 8 / 3, 4, 16 / 3, 6, 8, 32 / 3, 12] },
  // D2 D3 A3 B3 D4 F#4 B4 E5: D six-nine, the warmest.
  { name: "warm", ratios: [1, 2, 3, 10 / 3, 4, 5, 20 / 3, 9] },
  // A1 A2 E3 A3 D4 E4 A4 E5: A with a suspended fourth, low.
  { name: "low", ratios: [3 / 4, 3 / 2, 9 / 4, 3, 4, 9 / 2, 6, 9] },
  // F2 F3 C4 F4 A4 C5 E5 A5: F major seventh.
  { name: "bright", ratios: [6 / 5, 12 / 5, 18 / 5, 24 / 5, 6, 36 / 5, 9, 12] },
  // Bb1 Bb2 F3 Bb3 D4 F4 A4 D5: Bb major seventh, the darkest.
  { name: "deep", ratios: [4 / 5, 8 / 5, 12 / 5, 16 / 5, 4, 24 / 5, 6, 8] },
];

/**
 * Decade (log10 of the particle count) at which each voice is halfway in.
 * The bass is always on. At the app's default 2 million about four voices
 * sound; the eighth arrives only near a trillion.
 */
export const VOICE_ENTRY: readonly number[] = [-Infinity, 4, 5, 6, 7.5, 9, 10.5, 11.75];

/** Half width, in decades, of a voice's fade in. */
export const ENTRY_WIDTH = 0.45;

/**
 * Peak gain per voice. Higher voices are quieter: the ear is more sensitive up
 * there. The bass is held back a little so phone and laptop speakers, which
 * barely reproduce D2, still hear the voices above it.
 */
export const VOICE_WEIGHT: readonly number[] = [0.8, 0.62, 0.5, 0.4, 0.31, 0.24, 0.18, 0.14];

/** Beat rate between a voice's two detuned oscillators, in Hz. Slow shimmer, never vibrato. */
export const VOICE_BEAT: readonly number[] = [0.07, 0.09, 0.11, 0.13, 0.16, 0.19, 0.23, 0.27];

if (CHORDS.some((c) => c.ratios.length !== VOICES)) throw new Error("audio: every chord needs one ratio per voice");

/** Frequency of voice `v` in chord `chord`. */
export function voiceHz(chord: number, v: number): number {
  return ROOT_HZ * CHORDS[chord].ratios[v];
}

/**
 * Pitches for glints: the chord's upper voices, one and two octaves up,
 * kept between 500 and 2600 Hz so they sparkle without piercing.
 */
export function glintPitches(chord: number): number[] {
  const out: number[] = [];
  for (const r of CHORDS[chord].ratios.slice(3)) {
    for (const octave of [2, 4]) {
      const hz = ROOT_HZ * r * octave;
      if (hz >= 500 && hz <= 2600) out.push(hz);
    }
  }
  return out;
}

/** The bell that marks a dice roll: the new chord's sixth voice, an octave up. */
export function rollBellHz(chord: number): number {
  return voiceHz(chord, 5) * 2;
}

/** The bell for an accent: the chord's seventh voice, an octave up. */
export function accentBellHz(chord: number): number {
  return voiceHz(chord, 6) * 2;
}

/** The low bell for a new power of ten: the chord's fourth voice. */
export function milestoneBellHz(chord: number): number {
  return voiceHz(chord, 3);
}

/** The chord a roll moves to: never the current one, chosen by the roll's seed. */
export function nextChord(current: number, seed: number): number {
  const n = CHORDS.length;
  return (current + 1 + ((seed >>> 0) % (n - 1))) % n;
}
