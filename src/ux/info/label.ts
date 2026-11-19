/**
 * The sheet label: a small caption in the bottom right corner that says what
 * one sheet is doing, like the label next to a picture on a wall.
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
  show(facts: SheetFacts, level: LabelLevel): void;
  hide(): void;
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
      el.dataset.level = level;
      set(name, facts.name);
      set(text, facts.description);
      set(meta, `${sheetNumberLine(facts)} · ${sheetCountLine(facts)}`);
      el.classList.add("is-on");
      el.setAttribute("aria-hidden", "false");
    },
    hide() {
      // The text stays so the caption can fade out instead of blinking off.
      el.classList.remove("is-on");
      el.setAttribute("aria-hidden", "true");
    },
  };
}
