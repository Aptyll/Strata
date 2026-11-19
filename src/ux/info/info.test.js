// The promises the information layer makes, checked by `npm test`. No DOM, no GPU.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { KEYS } from "../../app/keys";
import { TOKENS_CSS } from "../design";
import { CAMERA_KEYS, POINTER_CONTROLS, TOUCH_CONTROLS, controlSections } from "./controls";
import {
  census,
  censusLine,
  countsDiffer,
  findSheet,
  sheetCountLine,
  sheetFacts,
  sheetNumberLine,
  simulatedOn,
  totals,
} from "./sheets";
import { INFO_CSS } from "./styles";
import { MEASURED, TERMS, exactCount, perPixel, plural, readingMs, shortCount } from "./words";

const behavior = (id, label, description) => ({ id, label, description });
const galaxy = behavior("galaxy", "Galaxy", "Wells pull particles into spiral arms.");
const flow = behavior("flow", "Flow field", "Particles ride a noise field.");
const bare = behavior("bare"); // a behavior whose author gave no label and no description

let nextX = 0;
const sheet = (b, capacity, activeCount = capacity, more = {}) => ({
  desc: { position: [nextX++, 0, 0] },
  behavior: b,
  capacity,
  activeCount,
  ...more,
});

// ---- words -----------------------------------------------------------------------------

test("counts are written short or exact, never ambiguous", () => {
  assert.equal(shortCount(1_048_576), "1.05M");
  assert.equal(shortCount(62_500), "62.5K");
  assert.equal(shortCount(999), "999");
  assert.equal(exactCount(1_000_000_000_000), "1,000,000,000,000");
  assert.equal(exactCount(1_209_600.4), "1,209,600");
  assert.equal(exactCount(Number.NaN), "-");
  assert.equal(plural(1, "sheet"), "1 sheet");
  assert.equal(plural(32, "sheet"), "32 sheets");
  assert.equal(plural(1_500, "flat sheet"), "1,500 flat sheets");
});

test("particles per pixel keeps three useful digits and survives a missing picture", () => {
  assert.equal(perPixel(2_000_000, 1920 * 1080), "0.96");
  assert.equal(perPixel(100_000_000, 1920 * 1080), "48.2");
  assert.equal(perPixel(800_000_000, 1920 * 1080), "386");
  assert.equal(perPixel(1_000, 0), "-");
});

test("a caption stays up long enough to read: 4 to 10 seconds, longer for more text", () => {
  assert.equal(readingMs(0), 4_000);
  assert.equal(readingMs(10), 4_000);
  assert.equal(readingMs(102), 7_000);
  assert.equal(readingMs(5_000), 10_000);
  assert.ok(readingMs(120) > readingMs(80));
});

test("every term has a word and a sentence, and the two modes are told apart", () => {
  for (const [key, term] of Object.entries(TERMS)) {
    assert.ok(term.word.length > 0, `${key} has no word`);
    assert.match(term.means, /^[A-Z].*\.$/s, `${key} must be defined in whole sentences`);
  }
  // The rule in CLAUDE.md: the trillion is rendered, never simulated; the live world is simulated.
  assert.equal(TERMS.simulated.word, "simulated");
  assert.equal(TERMS.rendered.word, "rendered");
  assert.doesNotMatch(TERMS.rendered.means, /simulat/i);
  assert.match(TERMS.rendered.means, /Nothing is stored/);
});

test("the measured numbers the about card quotes are the ones in the README", (t) => {
  const readme = resolve(process.cwd(), "README.md");
  if (!existsSync(readme)) return t.skip("run from the repository root to check against README.md");
  const text = readFileSync(readme, "utf8");
  const { exact, averaged } = MEASURED.trillionFrameSeconds;
  const hint = "README.md and MEASURED in src/ux/info/words.ts must quote the same measurement";
  assert.ok(text.includes(MEASURED.gpu), `${MEASURED.gpu} is not in the README. ${hint}`);
  assert.ok(text.includes(exactCount(MEASURED.trillion)), `the trillion is not written out in the README. ${hint}`);
  assert.ok(text.includes(`${averaged[0]} to ${averaged[1]}`), `"${averaged[0]} to ${averaged[1]}" seconds is not in the README. ${hint}`);
  assert.ok(text.includes(`${exact[0]} to\n${exact[1]}`) || text.includes(`${exact[0]} to ${exact[1]}`), `"${exact[0]} to ${exact[1]}" seconds is not in the README. ${hint}`);
});

// ---- sheets ----------------------------------------------------------------------------

test("one sheet's facts: number in the world, name, sentence and counts", () => {
  const sheets = [sheet(galaxy, 62_500), sheet(flow, 62_500, 31_250), sheet(bare, 100)];
  const facts = sheetFacts(sheets, sheets[1]);
  assert.deepEqual(facts, {
    number: 2,
    of: 3,
    name: "Flow field",
    description: "Particles ride a noise field.",
    simulated: 31_250,
    stored: 62_500,
  });
  assert.equal(sheetNumberLine(facts), "sheet 2 of 3");
  // No label falls back to the id; no description is an empty string, never "undefined".
  assert.deepEqual(
    [sheetFacts(sheets, sheets[2]).name, sheetFacts(sheets, sheets[2]).description],
    ["bare", ""],
  );
  assert.equal(sheetFacts(sheets, sheet(galaxy, 1)), null, "a sheet that is not in the world has no facts");
});

test("a sheet's count line always says what its particles are doing", () => {
  const line = (capacity, activeCount, more) => {
    const s = sheet(galaxy, capacity, activeCount, more);
    return sheetCountLine(sheetFacts([s], s));
  };
  assert.equal(line(62_500, 62_500), "62.5K particles simulated");
  assert.equal(line(62_500, 31_250), "31.3K of 62.5K particles simulated");
  assert.equal(line(62_500, 0), "62.5K particles stored, resting");
  // Paused sheets are drawn but not stepped, so they are not called simulated.
  assert.equal(line(62_500, 62_500, { paused: true }), "62.5K particles stored, resting");
});

test("simulated never exceeds stored and ignores paused sheets", () => {
  assert.equal(simulatedOn({ capacity: 100, activeCount: 250 }), 100);
  assert.equal(simulatedOn({ capacity: 100, activeCount: -5 }), 0);
  assert.equal(simulatedOn({ capacity: 100, activeCount: 60.9 }), 60);
  assert.equal(simulatedOn({ capacity: 100, activeCount: 100, paused: true }), 0);
  const world = [sheet(galaxy, 1_000), sheet(flow, 1_000, 0), sheet(flow, 1_000, 400), sheet(galaxy, 1_000, 1_000, { paused: true })];
  assert.deepEqual(totals(world), { sheets: 4, simulated: 1_400, stored: 4_000 });
  assert.deepEqual(totals([]), { sheets: 0, simulated: 0, stored: 0 });
});

test("the stats line shows a second count only when it would read differently", () => {
  assert.equal(countsDiffer({ simulated: 2_000_000, stored: 2_000_000 }), false);
  assert.equal(countsDiffer({ simulated: 1_999_999, stored: 2_000_000 }), false, "both read 2.00M");
  assert.equal(countsDiffer({ simulated: 1_200_000, stored: 2_000_000 }), true);
  assert.equal(countsDiffer({ simulated: 0, stored: 2_000_000 }), true);
});

test("the census lists behaviors by how many sheets run them, then by name", () => {
  const world = [sheet(galaxy, 100), sheet(flow, 200), sheet(flow, 300), sheet(bare, 50), sheet(galaxy, 100)];
  const rows = census(world);
  assert.deepEqual(rows.map((r) => [r.name, r.sheets, r.stored]), [
    ["Flow field", 2, 500],
    ["Galaxy", 2, 200],
    ["bare", 1, 50],
  ]);
  assert.equal(censusLine(rows[0]), "2 sheets, 500 particles stored");
  assert.equal(censusLine(rows[2]), "1 sheet, 50 particles stored");
});

test("a camera target is matched to its sheet by position", () => {
  const world = [sheet(galaxy, 1), sheet(flow, 1), sheet(bare, 1)];
  const [x, y, z] = world[1].desc.position;
  assert.equal(findSheet(world, [x, y, z]), world[1]);
  assert.equal(findSheet(world, [x + 1e-6, y, z]), world[1], "float noise still matches");
  assert.equal(findSheet(world, [x + 0.4, y, z]), null, "a point between sheets matches none");
  assert.equal(findSheet([], [0, 0, 0]), null);
});

// ---- controls --------------------------------------------------------------------------

test("every control row says what to do and what happens", () => {
  for (const rows of [POINTER_CONTROLS, TOUCH_CONTROLS, CAMERA_KEYS]) {
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(row.input.trim().length > 0 && row.does.trim().length > 0, JSON.stringify(row));
    }
    const inputs = rows.map((r) => r.input);
    assert.equal(new Set(inputs).size, inputs.length, "the same input is listed twice");
  }
});

test("a touch screen is shown touch gestures only; a desktop gets the pointer and the camera keys", () => {
  assert.deepEqual(controlSections(true).map((s) => s.title), ["touch"]);
  assert.deepEqual(controlSections(false).map((s) => s.title), ["pointer", "camera keys"]);
  assert.equal(controlSections(false)[1].rows, CAMERA_KEYS);
});

test("no key listed as a camera key is owned by the HUD or a feature in the app", () => {
  // src/app/keys.ts withholds every key in KEYS from the camera, so a row here that names one would be a lie.
  const owned = new Map(Object.values(KEYS).map((k) => [k.key.toLowerCase(), k]));
  const named = { space: " ", home: "home", shift: "shift" };
  for (const row of CAMERA_KEYS) {
    for (const token of row.input.split(/\s+/)) {
      // "w", ",", "." are single keys; "a," is a key followed by a list comma.
      const key = token.length === 1 ? token : token.length === 2 && token.endsWith(",") ? token[0] : (named[token.replace(/,$/, "")] ?? null);
      if (key == null) continue; // a word such as "arrows"
      const taken = owned.get(key);
      assert.equal(taken, undefined, `"${row.input}" lists ${JSON.stringify(key)}, which KEYS gives to ${taken?.owner} (${taken?.label})`);
    }
  }
});

// ---- styles ----------------------------------------------------------------------------

test("the stylesheet is built from design tokens that exist, with no colors or timings of its own", () => {
  const defined = new Set([...TOKENS_CSS.matchAll(/(--st-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = [...INFO_CSS.matchAll(/var\((--st-[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 40, "expected the stylesheet to be written with tokens");
  for (const name of new Set(used)) assert.ok(defined.has(name), `${name} is used but src/ux/design does not define it`);
  const css = INFO_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /rgba?\(|hsla?\(|#[0-9a-f]{3,8}\b/i, "colors come from the ink tokens");
  // "0s" (no delay) is the one duration that is not a design decision.
  assert.doesNotMatch(css, /\b(?!0s\b)\d+(\.\d+)?m?s\b/, "timings come from the motion tokens");
  assert.doesNotMatch(css, /font-family|font-size|\b\d+px [a-z-]+ (serif|sans|mono)/i, "type comes from the six roles");
});
