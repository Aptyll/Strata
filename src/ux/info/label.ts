/**
 * The sheet label: a small caption in the bottom right corner (top left on a
 * small screen) that says what one sheet is doing, like the label next to a
 * picture on a wall.
 *
 *   full    name, the behavior's one-sentence description, "sheet 7 of 32 ·
 *           62.5K particles simulated". Shown while the camera faces a sheet.
 *   short   name and the count line only. Shown for the sheet under the
 *           pointer while the stats line is on.
 *
 * It only draws what it is given. Which sheet and when is decided in ./index.ts.
 */
import { sheetCountLine, sheetNumberLine, type SheetFacts } from "./sheets";

export type LabelLevel = "short" | "full";

export interface SheetLabel {
  readonly el: HTMLElement;
  /** Show these facts. Returns how many characters of text are now on screen. */
  show(facts: SheetFacts, level: LabelLevel): number;
  hide(): void;
  /** While held, the label stays up even when the rest of the HUD fades for idleness. */
  hold(on: boolean): void;
}

export function createSheetLabel(root: HTMLElement): SheetLabel {
  const doc = root.ownerDocument;
  const el = doc.createElement("div");
  el.className = "si-sheet";
  el.setAttribute("aria-hidden", "true");
  // Only the name is announced: the count below it changes too often to read out.
  const name = doc.createElement("div");
  name.className = "si-sheet-name";
  name.setAttribute("role", "status");
  const text = doc.createElement("div");
  text.className = "si-sheet-text";
  const meta = doc.createElement("div");
  meta.className = "si-sheet-meta";
  el.append(name, text, meta);
  root.append(el);

  const set = (node: HTMLElement, value: string) => {
    if (node.textContent !== value) node.textContent = value;
  };

  return {
    el,
    show(facts, level) {
      const line = `${sheetNumberLine(facts)} · ${sheetCountLine(facts)}`;
      // Exposed before the name changes, so a screen reader hears the new name.
      el.setAttribute("aria-hidden", "false");
      el.dataset.level = level;
      set(name, facts.name);
      set(text, facts.description);
      set(meta, line);
      el.classList.add("is-on");
      return facts.name.length + line.length + (level === "full" ? facts.description.length : 0);
    },
    hide() {
      // The text stays so the caption can fade out instead of blinking off.
      el.classList.remove("is-on", "is-held");
      el.setAttribute("aria-hidden", "true");
    },
    hold(on) {
      el.classList.toggle("is-held", on);
    },
  };
}
