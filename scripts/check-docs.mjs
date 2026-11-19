#!/usr/bin/env node
/**
 * npm run check:docs: do the docs still match the code?
 *
 * Three pages list the folders of src/ (CLAUDE.md, src/README.md and
 * docs/CODEMAP.md), and with many threads adding folders at once they drift.
 * This script reads the docs and the tree and reports:
 *
 *   - a folder under src/ with no README.md, or with no row in one of the
 *     three maps
 *   - a row in a map for a folder that is gone
 *   - a page built by vite.config.ts that the code map's "Pages" table leaves out
 *   - `npm run <name>` in a doc when package.json has no such script
 *   - a path in backticks (`src/...`, `docs/...`, `scripts/...`, `.github/...`,
 *     or a page address like `/src/offline/web/`) that points at nothing
 *
 * The docs it reads are the ones that describe the code as it is: CLAUDE.md,
 * README.md, every .md under docs/ and every README.md under src/. The
 * folders of docs/ that tell history (briefs, journal, story) are left alone.
 *
 * It only reads files: no dependencies, no GPU, a few milliseconds.
 *
 *   npm run check:docs      list every gap, exit 1 if there is one
 *   npm run build           runs it last with --warn (the postbuild script):
 *                           gaps are printed as a warning, the build still passes
 *
 * A path that is an example on purpose (a file a reader is told to create)
 * is skipped when it holds a placeholder such as <id> or *, or when the line
 * carries the comment <!-- docs-check: ignore -->.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const warnOnly = process.argv.includes("--warn");

const at = (path) => join(root, path);
const read = (path) => readFileSync(at(path), "utf8");
const isDir = (path) => existsSync(at(path)) && statSync(at(path)).isDirectory();
const isFile = (path) => existsSync(at(path)) && statSync(at(path)).isFile();

/** Every gap found: { where: "file:line" or "file", what: one sentence }. */
const gaps = [];
const gap = (where, what) => gaps.push({ where, what });

// ---------------------------------------------------------------------------
// 1. Folders of src/ against the three maps.

/** The maps: where each one is, how to recognise a row, and what a row for `name` looks like. */
const MAPS = [
  { file: "CLAUDE.md", row: /^\|\s*`([a-z0-9-]+)\/`\s*\|/, example: (n) => `| \`${n}/\` | what lives there |` },
  { file: "src/README.md", row: /^\|\s*`([a-z0-9-]+)\/`\s*\|/, example: (n) => `| \`${n}/\` | What it does | Status |` },
  { file: "docs/CODEMAP.md", row: /^\|\s*`src\/([a-z0-9-]+)`\s*\|/, example: (n) => `| \`src/${n}\` | role | start reading at |` },
];

function checkFolders() {
  const folders = readdirSync(at("src"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const name of folders) {
    if (!isFile(`src/${name}/README.md`)) {
      gap(`src/${name}/`, `has no README.md. Add one: what it does, key files, how it is used, status.`);
    }
  }

  for (const map of MAPS) {
    if (!isFile(map.file)) {
      gap(map.file, "is missing, and it is one of the three maps of src/.");
      continue;
    }
    const listed = new Map(); // folder name -> line number
    read(map.file)
      .split("\n")
      .forEach((line, i) => {
        const m = map.row.exec(line);
        if (m && !listed.has(m[1])) listed.set(m[1], i + 1);
      });
    for (const name of folders) {
      if (!listed.has(name)) gap(map.file, `has no row for src/${name}/. Add one like: ${map.example(name)}`);
    }
    for (const [name, line] of listed) {
      if (!folders.includes(name)) gap(`${map.file}:${line}`, `lists src/${name}/, which does not exist.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Pages the build ships against the code map's "Pages" table.

function checkPages() {
  if (!isFile("vite.config.ts") || !isFile("docs/CODEMAP.md")) return;
  const built = [...read("vite.config.ts").matchAll(/["']((?:src\/[^"']+\/)?index\.html)["']/g)].map((m) => m[1]);
  const codemap = read("docs/CODEMAP.md");
  const start = codemap.indexOf("\n## Pages");
  const end = codemap.indexOf("\n## ", start + 1);
  const pages = start < 0 ? "" : codemap.slice(start, end < 0 ? undefined : end);
  for (const file of built) {
    const address = `/${file.replace(/index\.html$/, "")}`; // "index.html" -> "/", "src/x/index.html" -> "/src/x/"
    if (!pages.includes(`\`${address}\``)) {
      gap("docs/CODEMAP.md", `"Pages" has no row for \`${address}\`, a page vite.config.ts builds.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3 and 4. npm scripts and paths named in the docs.

/** Folders of docs/ that tell history: what was planned or true at the time, not what is there now. */
const HISTORY = ["docs/briefs", "docs/journal", "docs/story"];

/** The docs that describe the code as it is: the guide, the docs of each area, and every folder's own README. */
function docsToRead() {
  const files = ["CLAUDE.md", "README.md"];
  const walk = (dir, wanted) => {
    for (const e of readdirSync(at(dir), { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !HISTORY.includes(path)) walk(path, wanted);
      } else if (wanted(e.name)) {
        files.push(path);
      }
    }
  };
  walk("docs", (name) => name.endsWith(".md"));
  walk("src", (name) => name === "README.md");
  return files.filter(isFile);
}

/** True when `path` names something in the repo: a file, a folder, or a module without its extension. */
function exists(path) {
  if (existsSync(at(path))) return true;
  return [".ts", ".mjs", ".js", ".wgsl"].some((ext) => isFile(path + ext));
}

function checkMentions() {
  const scripts = Object.keys(JSON.parse(read("package.json")).scripts ?? {});
  const lifecycle = new Set(["install", "ci", "test", "start"]); // `npm test`, `npm ci`: not `npm run` names

  for (const file of docsToRead()) {
    let fenced = false;
    read(file)
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        if (line.includes("docs-check: ignore")) return;
        const where = `${file}:${i + 1}`;

        for (const m of line.matchAll(/\bnpm run ([a-z][a-z0-9:_-]*)/g)) {
          if (!scripts.includes(m[1]) && !lifecycle.has(m[1])) {
            gap(where, `says \`npm run ${m[1]}\`, and package.json has no script of that name.`);
          }
        }

        // Paths are only trusted inside backticks (or a fenced block): prose
        // may say "src/foo" loosely, code spans are meant literally.
        const spans = fenced ? [line] : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        for (const span of spans) {
          for (const word of span.split(/[\s,;()'"]+/)) {
            const path = mentionedPath(word);
            if (path && !exists(path)) gap(where, `names \`${word}\`, which does not exist.`);
          }
        }
      });
  }
}

/**
 * The repo path a word in a code span points at, or null when the word is
 * not a path this script should judge (an example with a placeholder, an
 * address outside the repo, an output file).
 */
function mentionedPath(word) {
  if (/[<>*{}$|]|\.\.\./.test(word)) return null; // a placeholder or a pattern
  let path = word.replace(/[?#].*$/, "").replace(/:\d+(-\d+)?$/, "").replace(/[.:]+$/, "");
  if (path.startsWith("/src/")) {
    // A dev server address: /src/offline/web/ is src/offline/web/index.html.
    path = path.slice(1);
    if (path.endsWith("/")) return `${path}index.html`;
    return path;
  }
  if (path.startsWith("./")) path = path.slice(2);
  if (!/^(src|docs|scripts|\.github)\//.test(path)) return null;
  if (!/^[A-Za-z0-9_./@-]+$/.test(path)) return null;
  return path.replace(/\/$/, "");
}

// ---------------------------------------------------------------------------

function main() {
  checkFolders();
  checkPages();
  checkMentions();

  if (gaps.length === 0) {
    if (!warnOnly) console.log("docs check: the maps and the paths in the docs match the code");
    return 0;
  }

  const lines = gaps.map((g) => `  ${g.where} ${g.what}`);
  const github = process.env.GITHUB_ACTIONS === "true";
  if (warnOnly) {
    const shown = lines.slice(0, 8);
    console.warn(`\n[docs] ${gaps.length} place${gaps.length === 1 ? "" : "s"} where the docs no longer match the code (a warning, the build is fine):`);
    console.warn(shown.join("\n"));
    if (lines.length > shown.length) console.warn(`  and ${lines.length - shown.length} more: npm run check:docs`);
    if (github) {
      // Shows up as a yellow note on the run's summary page.
      for (const g of gaps.slice(0, 10)) {
        const [file, line] = g.where.split(":");
        console.log(`::warning file=${file}${line ? `,line=${line}` : ""},title=Docs do not match the code::${g.where} ${g.what}`);
      }
    }
    return 0;
  }
  console.error(`docs check: ${gaps.length} place${gaps.length === 1 ? "" : "s"} where the docs do not match the code\n`);
  console.error(lines.join("\n"));
  return 1;
}

try {
  process.exitCode = main();
} catch (err) {
  // With --warn this runs at the end of every build: a bug here must never fail one.
  console.error(`docs check: could not run (${err?.message ?? err})`);
  process.exitCode = warnOnly ? 0 : 2;
}
