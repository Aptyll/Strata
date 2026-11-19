// The menu table's own rules, checked without a browser. Run with `npm test -- menu`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MENU, menuLayout } from "./menu";

const rows = MENU.flatMap((page) => page.sections.flatMap((s) => (s.rows ?? []).map((row) => ({ page, section: s, row }))));

test("every control is listed once", () => {
  const seen = new Map();
  for (const { page, section, row } of rows) {
    const where = `${page.id} / ${section.group}`;
    assert.ok(!seen.has(row.id), `"${row.id}" is listed under ${seen.get(row.id)} and under ${where}`);
    seen.set(row.id, where);
  }
});

test("group names are lower case and each page lists a group once", () => {
  for (const page of MENU) {
    const groups = [...page.sections.map((s) => s.group), ...(page.also ?? [])];
    for (const g of groups) assert.equal(g, g.toLowerCase(), `group "${g}" on ${page.id} must be lower case`);
    assert.equal(new Set(groups).size, groups.length, `${page.id} lists a group twice`);
  }
});

test("a group belongs to one page, so a control that only names its group lands in one place", () => {
  const owner = new Map();
  for (const page of MENU) {
    for (const g of [...page.sections.map((s) => s.group), ...(page.also ?? [])]) {
      if (g === "advanced") continue; // every page has its own; it needs a `page` to pick one
      assert.ok(!owner.has(g), `group "${g}" is on ${owner.get(g)} and on ${page.id}`);
      owner.set(g, page.id);
    }
  }
});

test('"more" is last and lists nothing, so it catches what no page claims', () => {
  const last = MENU[MENU.length - 1];
  assert.equal(last.id, "more");
  assert.equal(last.sections.length, 0);
  assert.equal(last.also, undefined);
});

test("a control only depends on a switch that is in the menu", () => {
  const ids = new Set(rows.map((r) => r.row.id));
  for (const { row } of rows) if (row.needs) assert.ok(ids.has(row.needs), `"${row.id}" needs "${row.needs}", which is not listed`);
});

test("the page tabs fit on one line", () => {
  // menu-styles.js: the tab row has about 27em of room; a character is about 0.64em wide
  // (monospace advance plus tracking) and the gap between tabs is 0.8em. "more" only shows
  // when something is unplaced, so it is not counted.
  const tabs = MENU.filter((p) => p.id !== "more").map((p) => p.label);
  const width = tabs.join("").length * 0.64 + (tabs.length - 1) * 0.8;
  assert.ok(width <= 27, `tabs "${tabs.join(" ")}" need about ${width.toFixed(1)}em of 27em`);
});

test("menuLayout: rows keep the table's order and land in their section", () => {
  const layout = menuLayout();
  const params = layout.params ?? {};
  assert.deepEqual(params.particles, { page: "scene", group: "world", order: 0, hint: params.particles.hint });
  assert.equal(params.planes.order, 1);
  assert.equal(params.targetFps.needs, "adaptive");
  assert.equal(params.record.label, "render");
  assert.equal(Object.keys(params).length, rows.length);
});

test("menuLayout: every page but behaviors is stacked and ends with a folded advanced section", () => {
  const pages = menuLayout().pages ?? [];
  assert.deepEqual(pages.map((p) => p.id), MENU.map((p) => p.id));
  for (const page of pages) {
    if (page.id === "behaviors") {
      assert.equal(page.stack, false);
      continue;
    }
    assert.equal(page.stack, true);
    assert.equal(page.groups[page.groups.length - 1], "advanced", `${page.id} must end with advanced`);
    assert.ok(page.fold?.includes("advanced"), `${page.id}: advanced must start folded`);
  }
  const perf = pages.find((p) => p.id === "perf");
  assert.deepEqual(perf?.groups.slice(0, 4), ["timing", "performance", "particles", "tests"]);
  assert.equal(perf?.labels?.performance, "frame rate");
});
