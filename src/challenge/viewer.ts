/**
 * Challenge mode's count block: the number, what it means, and what to do next.
 *
 * The readout in the bottom left corner is an instrument panel. This block is
 * for someone who arrived to see what their own GPU can do: one big count at
 * the top, a line saying what the count is (simulated or rendered, always), a
 * line saying what is happening, and buttons, so nothing needs a keyboard:
 *
 *   searching   back to the world · details
 *   done        copy result · run again · back to the world · details
 *
 * "copy result" gives one sentence for a comment (resultSentence in share.ts);
 * key C still copies the full JSON. It is offered only for a finished run whose
 * particles the GPU counted itself. The words live in share.ts, pure and
 * tested; this file is the DOM around them.
 */

import { TYPE, installTokens } from "../ux/design";
import { challengeLink, gpuName, resultSentence, viewerText, worldLink } from "./share";
import type { RunFacts } from "./share";

const CSS = `
.strata-challenge { position: fixed; z-index: var(--st-z-hud); top: var(--st-edge-top); left: var(--st-edge-left); right: var(--st-edge-right);
  display: flex; flex-direction: column; align-items: center; text-align: center;
  pointer-events: none; user-select: none; -webkit-user-select: none; text-shadow: var(--st-halo);
  animation: sc-arrive var(--st-slow) var(--st-ease-soft) both;
  transition: opacity var(--st-fast) var(--st-ease), visibility 0s; }
.strata-challenge.is-hidden { opacity: 0; visibility: hidden; transition: opacity var(--st-fast) var(--st-ease), visibility 0s linear var(--st-fast); }
@keyframes sc-arrive { from { opacity: 0; } }
.strata-challenge p { margin: 0; }
.strata-challenge [hidden] { display: none !important; }
.strata-challenge .sc-figure { ${TYPE.figure} }
.strata-challenge .sc-what { ${TYPE.fine} margin-top: var(--st-space-1); }
.strata-challenge .sc-caption { ${TYPE.caption} margin-top: var(--st-space-2); text-indent: var(--st-track-wide); }
.strata-challenge .sc-conditions { ${TYPE.fine} margin-top: var(--st-space-1); }
.strata-challenge .sc-body { ${TYPE.body} max-width: 46ch; margin-top: var(--st-space-2); }
.strata-challenge .sc-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--st-space-2);
  margin-top: var(--st-space-3); pointer-events: auto; text-shadow: none; }
.strata-challenge .sc-actions > * { ${TYPE.data} display: inline-flex; align-items: center; justify-content: center;
  box-sizing: border-box; min-height: var(--st-hit); margin: 0; padding: 0 var(--st-space-3);
  background: var(--st-surface); border: 1px solid var(--st-stroke); border-radius: var(--st-radius);
  appearance: none; -webkit-appearance: none; -webkit-tap-highlight-color: transparent; cursor: pointer; text-decoration: none;
  transition: color var(--st-fast) var(--st-ease), border-color var(--st-fast) var(--st-ease); }
.strata-challenge .sc-actions > [aria-pressed=true] { color: var(--st-strong); }
.strata-challenge .sc-actions > *:hover { color: var(--st-lit); border-color: var(--st-strong); }
.strata-challenge .sc-actions > *:focus-visible { outline: var(--st-focus); outline-offset: 2px; }
.strata-challenge .sc-copy { ${TYPE.fine} max-width: 64ch; margin-top: var(--st-space-2); pointer-events: auto;
  user-select: text; -webkit-user-select: text; overflow-wrap: anywhere; }
.strata-challenge .sc-copy:empty { display: none; }
.strata-challenge .sc-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* A message with no run behind it (no WebGPU) sits in the middle, where the app puts its messages. */
.strata-challenge.is-message { top: 0; bottom: 0; justify-content: center; }
/* The readout is long lines of instrument text: on a narrow screen they wrap instead of leaving it. */
.strata-challenge-readout { max-width: calc(100vw - var(--st-edge-left) - var(--st-edge-right)); white-space: pre-wrap !important; }
`;

export interface ViewerOptions {
  /** The instrument readout (bottom left). "details" and key I show and hide it. */
  readout: HTMLElement;
  /** Start the run again from the beginning. */
  restart(): void;
  parent?: HTMLElement;
}

export interface ChallengeViewer {
  /** Show a run's state. Meant to be called every time the readout is drawn; the DOM changes only when a line does. */
  update(facts: RunFacts): void;
  /** Replace the run with a message and the way back: a short first line, then sentences. */
  explain(title: string, ...sentences: string[]): void;
  /** Hide or show all of Challenge mode's chrome, for a clean picture (key I). */
  toggle(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** Hand a sentence to the person: the share sheet on a phone, else the clipboard, else show it to be selected. */
async function give(text: string, sheet: boolean): Promise<"given" | "shown"> {
  if (sheet) {
    try {
      await navigator.share({ text });
      return "given";
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "AbortError") return "given"; // the person closed the sheet
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "given";
  } catch {
    return "shown";
  }
}

export function mountChallengeViewer(options: ViewerOptions): ChallengeViewer {
  installTokens();
  if (!document.getElementById("strata-challenge-style")) {
    const style = el("style", "");
    style.id = "strata-challenge-style";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const root = el("section", "strata-challenge");
  root.setAttribute("aria-label", "Challenge");
  const figure = el("p", "sc-figure");
  const what = el("p", "sc-what");
  const caption = el("p", "sc-caption");
  const conditions = el("p", "sc-conditions");
  const body = el("p", "sc-body");
  const actions = el("div", "sc-actions");
  const copied = el("p", "sc-copy");
  const live = el("p", "sc-live");
  live.setAttribute("aria-live", "polite");
  body.hidden = true;

  const coarse = matchMedia("(pointer: coarse)").matches;
  const sheet = coarse && typeof navigator.share === "function";
  const copyLabel = sheet ? "share result" : "copy result";
  const button = (label: string, run: () => void): HTMLButtonElement => {
    const b = el("button", "", label);
    b.type = "button";
    b.addEventListener("click", () => {
      run();
      b.blur(); // the next key belongs to the camera and to Challenge mode's own keys
    });
    return b;
  };

  let latest: RunFacts | null = null;
  let copyTimer = 0;
  const copy = button(copyLabel, () => {
    if (!latest) return;
    const text = resultSentence(latest, challengeLink(location.href));
    void give(text, sheet).then((how) => {
      copied.textContent = how === "shown" ? text : "";
      if (how === "shown" || sheet) return;
      copy.textContent = "copied";
      clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => (copy.textContent = copyLabel), 2000);
    });
  });
  const again = button("run again", () => options.restart());
  const reload = button("reload", () => location.reload());
  const back = el("a", "", "back to the world");
  back.href = worldLink(location.href);

  // The readout: shown from the start where there is room and a keyboard for its keys, one tap away elsewhere.
  const readout = options.readout;
  readout.classList.add("strata-challenge-readout");
  let detailsOn = matchMedia("(min-width: 720px) and (pointer: fine)").matches;
  let allHidden = false;
  const details = button("details", () => {
    detailsOn = !detailsOn;
    place();
  });
  const place = () => {
    readout.style.display = detailsOn && !allHidden ? "" : "none";
    details.setAttribute("aria-pressed", String(detailsOn));
    root.classList.toggle("is-hidden", allHidden);
  };
  place();

  actions.append(copy, again, reload, back, details);
  root.append(figure, what, caption, conditions, body, actions, copied, live);

  const parent = options.parent ?? document.body;
  const show = () => {
    if (!root.isConnected) parent.appendChild(root);
  };
  /** Write a line only when it changed: this runs several times a second. */
  const shown = new Map<HTMLElement, string>();
  const write = (node: HTMLElement, text: string) => {
    if (shown.get(node) === text) return;
    shown.set(node, text);
    node.textContent = text;
  };

  let wasOver = false;
  return {
    update(facts) {
      latest = facts;
      const t = viewerText(facts);
      write(figure, t.figure);
      write(what, t.what);
      write(caption, t.caption);
      write(conditions, t.conditions);
      copy.hidden = !t.shareable;
      again.hidden = !t.over || facts.lost !== null;
      reload.hidden = facts.lost === null;
      if (!t.shareable) copied.textContent = "";
      // Said once to a screen reader when the search ends; the climbing number is not read out.
      if (t.over && !wasOver) live.textContent = `${t.figure} ${t.what}. ${t.caption}.`;
      wasOver = t.over;
      show();
    },
    explain(title, ...sentences) {
      latest = null;
      root.classList.add("is-message");
      for (const node of [figure, what, conditions, copy, again, reload, details]) node.hidden = true;
      body.hidden = false;
      write(caption, title);
      write(body, sentences.join(" "));
      show();
    },
    toggle() {
      allHidden = !allHidden;
      place();
    },
  };
}

/**
 * The GPU's name for people, and whether it is a CPU renderer. Asks WebGL on
 * a throwaway canvas for the name of the card, because WebGPU does not give
 * one; gpuName (share.ts) decides whether the two are the same card.
 */
export function describeGpu(adapter: GPUAdapter, adapterOptions: GPURequestAdapterOptions = {}): { name: string; software: boolean } {
  let renderer: string | null = null;
  try {
    // Ask for the same kind of card WebGPU was asked for, so a laptop with two answers with the same one.
    const gl = document.createElement("canvas").getContext("webgl", {
      powerPreference: adapterOptions.powerPreference ?? "default",
    });
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    // Without the extension the renderer is a generic "WebKit WebGL", which names nothing.
    const name: unknown = gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    if (typeof name === "string" && name) renderer = name;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    renderer = null;
  }
  const flags = adapter as { isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean } };
  return gpuName({
    adapter: adapter.info ?? {},
    renderer,
    rendererIsStandIn: /Firefox\//.test(navigator.userAgent),
    fallbackAdapter: !!(flags.isFallbackAdapter ?? flags.info?.isFallbackAdapter),
  });
}
