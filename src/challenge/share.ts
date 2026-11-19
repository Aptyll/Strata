/**
 * Challenge mode's words: what the count block says in each state of a run,
 * the one sentence people paste into a comment, the name of the GPU, and the
 * links in and out. Pure: no DOM, no GPU, tested by share.test.js.
 *
 * The rules these words keep (CLAUDE.md, "Honest counting"):
 *   - a count always says "simulated" or "rendered" next to it
 *   - a frame rate is attached to a count only when it was measured at that count
 *   - nothing is offered for copying unless the GPU's own count matched
 */

import type { ChallengeResult } from "./main";
import type { RampPhase } from "./ramp";

/** What the count block needs to know about a run, taken every time the readout is drawn. */
export interface RunFacts {
  /** The latest result, the same object key C copies as JSON. */
  result: ChallengeResult;
  /** Where the search is, or "fixed" when ?count= runs one count with no search. */
  phase: RampPhase | "fixed";
  /** Checked frames whose GPU count was off since the run started. */
  mismatches: number;
  /** The search stopped because more particles did not fit in GPU memory. */
  memoryLimited: boolean;
  /** The browser is drawing on the CPU (a fallback adapter), not on a graphics card. */
  software: boolean;
  /** Message of a lost device, or null while it is alive. */
  lost: string | null;
}

export interface ViewerText {
  /** The hero number: particles in every frame right now, or the sustained record. */
  figure: string;
  /** What the number counts. Always says simulated or rendered. */
  what: string;
  /** One line spoken to the person: what is happening, or what the number means. */
  caption: string;
  /** Conditions of the run: live frame rate while searching, then the GPU, buffer size and sheets. */
  conditions: string;
  /** Nothing more will change until the run is started again. */
  over: boolean;
  /** A result worth copying exists: measured, finished or fixed, and counted right by the GPU. */
  shareable: boolean;
}

const count = (n: number): string => Math.round(n).toLocaleString("en-US");
const rate = (fps: number): string => fps.toFixed(1);

/** The text of the count block for one moment of a run. */
export function viewerText(facts: RunFacts): ViewerText {
  const r = facts.result;
  const sim = r.mode === "sim";
  const fixed = facts.phase === "fixed";
  const over = facts.phase === "hold" || facts.lost !== null;
  const measured = r.fps > 0;
  const valid = facts.mismatches === 0 && facts.lost === null;
  // Only a finished search or a fixed count has a frame rate that belongs to this count:
  // while the search runs, the last measured window may be from the count before.
  const settled = (facts.phase === "hold" && r.sustained) || fixed;

  const kind = sim ? "simulated" : "rendered";
  const at = settled && measured ? ` at ${rate(r.fps)} fps` : "";
  // A device that stopped mid-search leaves a count nothing was measured at: say only what the last frame was.
  const span = facts.lost !== null && !settled ? "in the last frame" : `every frame${at}`;
  const what = `particles ${kind} ${span}${sim ? "" : ", not simulated"}`;

  let caption: string;
  if (facts.lost !== null) caption = "the graphics device stopped";
  else if (facts.mismatches > 0) caption = "result invalid: the GPU counted a different number";
  else if (facts.software) caption = "running on the CPU: this browser is not using a graphics card";
  else if (fixed) caption = "fixed count, no search";
  else if (facts.phase !== "hold") caption = `finding the most this GPU holds at ${r.targetFps} fps`;
  else if (!r.sustained) caption = `this GPU cannot hold ${r.targetFps} fps here`;
  else if (r.stoppedBy === "ceiling") {
    caption = facts.memoryLimited ? "limited by GPU memory, not by frame rate" : "the most this mode can run, not the limit of this GPU";
  } else caption = `the most this GPU holds at ${r.targetFps} fps`;
  if (r.tier1 && valid) caption += " · tier 1 reached";

  const size = `${r.width}x${r.height} · ${r.planes} sheets`;
  const live = `${measured ? rate(r.fps) : "--"} fps · ${size}`;
  const conditions = settled || over ? [r.gpuName, size].filter((s) => s).join(" · ") : live;

  return {
    figure: r.particles > 0 ? count(r.particles) : "--",
    what,
    caption,
    conditions,
    over,
    shareable: settled && measured && valid && r.gpuCountVerified,
  };
}

/**
 * One sentence for a comment or a message. Says what the number is before
 * anything else, so a clipped quote cannot turn "rendered" into "simulated".
 */
export function resultSentence(facts: RunFacts, link: string): string {
  const r = facts.result;
  const sim = r.mode === "sim";
  const notes: string[] = [];
  if (!sim) notes.push("not simulated");
  if (facts.phase === "fixed") notes.push("fixed count");
  else if (r.stoppedBy === "ceiling") notes.push(facts.memoryLimited ? "limited by GPU memory" : "limited by the mode's cap");
  const head = sim ? "Strata challenge" : "Strata challenge, procedural mode";
  const on = facts.software ? " on a software renderer (no graphics card)" : r.gpuName ? ` on ${r.gpuName}` : "";
  return (
    `${head}: ${count(r.particles)} particles ${sim ? "simulated" : "rendered"} every frame at ${rate(r.fps)} fps` +
    `${notes.map((n) => `, ${n}`).join("")} (${r.width}x${r.height}, ${r.planes} sheets)${on}. ${link}`
  );
}

// ------------------------------------------------------------- links ----

/** Options only Challenge mode reads. The app's own options (and the ones both read) stay in a link back. */
const CHALLENGE_ONLY = ["challenge", "mode", "res", "count", "start", "wg"];

/** The standard challenge on this site: what a shared result points at, whatever options this run had. */
export function challengeLink(href: string): string {
  const url = new URL(href);
  // From the app the mode is ?challenge; the standalone page needs nothing.
  return `${url.origin}${url.pathname}${url.searchParams.has("challenge") ? "?challenge" : ""}`;
}

/** The way back to the world from either page Challenge mode runs on. */
export function worldLink(href: string): string {
  const url = new URL(href);
  if (!url.searchParams.has("challenge")) {
    // The standalone page lives two folders under the site root, in dev and on the live site.
    const at = url.pathname.lastIndexOf("src/challenge/");
    return `${url.origin}${at < 0 ? "/" : url.pathname.slice(0, at)}`;
  }
  // Opened from the app's menu: the app's own options are still in the address, so they come back with us.
  for (const key of CHALLENGE_ONLY) url.searchParams.delete(key);
  return url.toString();
}

// ----------------------------------------------------------- GPU name ----

/** Split "a, b (c, d), e" at the commas outside parentheses. */
function splitOutside(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts;
}

/**
 * The part of a WebGL renderer string people know their graphics card by:
 * "ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 (0x00001F02) Direct3D11 vs_5_0 ps_5_0, D3D11)"
 * becomes "NVIDIA GeForce RTX 2070".
 */
export function rendererName(renderer: string): string {
  let s = renderer.trim();
  const angle = /^ANGLE \((.*)\)$/.exec(s);
  if (angle) {
    // "vendor, renderer, driver", or "vendor, renderer" from some browsers. A vendor
    // can hold a comma of its own ("Co., Ltd."), so count from the end.
    const parts = splitOutside(angle[1]);
    s = parts[parts.length >= 3 ? parts.length - 2 : parts.length - 1];
  }
  s = s.replace(/^ANGLE \((.+)\) on .*$/, "$1");
  const vulkan = /^Vulkan [\d.]+ \((.*)\)$/.exec(s);
  if (vulkan) s = vulkan[1];
  return s
    .replace(/^ANGLE Metal Renderer: /, "")
    .replace(/\s*\(0x[0-9a-f]+\)/gi, "") // device id
    .replace(/\s+(Direct3D|OpenGL).*$/i, "") // API and shader model
    .replace(/\/PCIe.*$/i, "") // "/PCIe/SSE2"
    .replace(/\s*\([^()]*\b(LLVM|DRM)\b[^()]*\)$/i, "") // Mesa's driver details
    .replace(/\s*\((R|TM)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(\S+) \1 /, "$1 "); // "NVIDIA NVIDIA GeForce"
}

/** Words a renderer string uses for each vendor name WebGPU reports. */
const VENDOR_WORDS: Record<string, string[]> = {
  nvidia: ["nvidia", "geforce", "quadro"],
  amd: ["amd", "radeon"],
  intel: ["intel"],
  apple: ["apple"],
  qualcomm: ["qualcomm", "adreno"],
  arm: ["mali", "immortalis"],
  "img-tec": ["powervr", "imagination"],
  samsung: ["xclipse", "samsung"],
  google: ["swiftshader", "google"],
  microsoft: ["microsoft"],
  mesa: ["llvmpipe", "softpipe", "mesa"],
};

const SOFTWARE = /swiftshader|llvmpipe|softpipe|basic render|warp/i;

export interface GpuNameInput {
  /** WebGPU's adapter info. Chrome gives a vendor and an architecture ("nvidia", "turing"), rarely a model. */
  adapter: { vendor?: string; architecture?: string; device?: string; description?: string };
  /** WebGL's unmasked renderer string from the same page, or null when the browser does not give one. */
  renderer: string | null;
  /** Firefox reports a few stand-in models for whole families of cards, so its renderer string names the wrong card. */
  rendererIsStandIn?: boolean;
  /** The adapter's own flag for a CPU renderer. */
  fallbackAdapter?: boolean;
}

/**
 * The name to show for the GPU a run used, and whether it is a CPU renderer.
 *
 * WebGPU says little about the card and WebGL names it, but on a machine with
 * two cards WebGL can be on the other one. So WebGL's name is used only when
 * its vendor is the WebGPU adapter's vendor; otherwise the adapter's own words
 * are shown, and an empty name means "say nothing" rather than guess.
 */
export function gpuName(input: GpuNameInput): { name: string; software: boolean } {
  const a = input.adapter;
  const own = [a.vendor, a.architecture, a.device, a.description].filter((s) => s).join(" ");
  const vendor = (a.vendor ?? "").toLowerCase();
  let name = own;
  if (input.renderer && !input.rendererIsStandIn) {
    const words = VENDOR_WORDS[vendor];
    const text = input.renderer.toLowerCase();
    // An adapter that names no vendor cannot contradict WebGL; a vendor we have no words for is compared by name.
    const sameCard = vendor === "" || (words ? words.some((w) => text.includes(w)) : text.includes(vendor));
    if (sameCard) name = rendererName(input.renderer) || own;
  }
  const software = !!input.fallbackAdapter || SOFTWARE.test(name) || SOFTWARE.test(own);
  return { name, software };
}
