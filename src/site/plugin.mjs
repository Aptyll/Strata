/**
 * The Vite plugin behind the published site. vite.config.ts loads it.
 *
 * What it does, for `npm run dev` and `npm run build` alike:
 *   - writes each page's <title>, description, link preview tags and canonical
 *     address from its row in ./pages.ts (the tag builder is ./head.ts)
 * and for the build only:
 *   - publishes the share card under a name that contains a hash of its bytes
 *   - writes sitemap.xml (and robots.txt when the site sits at a domain's root)
 *   - prints what index.html loads before the first frame, and warns when
 *     that goes over LANDING_BUDGET_KB
 *
 * It runs in Node, so it is plain .mjs like the repo's other Node code; the
 * typed parts are the two .ts files next to it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { applyHead, sitemapXml } from "./head.ts";
import { LANDING_BUDGET_KB, PAGES, SITE } from "./pages.ts";

const slashed = (path) => path.split("\\").join("/");
const kB = (bytes) => (bytes / 1024).toFixed(1);

/** @returns {import("vite").Plugin} */
export function strataSite() {
  /** @type {import("vite").ResolvedConfig} */
  let config;
  let siteUrl = SITE.url;
  /** @type {Map<string, { source: Buffer, published: string }>} card file -> its bytes and published path */
  const cards = new Map();
  const said = new Set();

  /** Logs a line once per run; the dev server would otherwise repeat it on every page load. */
  const note = (text, level = "info") => {
    if (said.has(text)) return;
    said.add(text);
    config.logger[level](`[site] ${text}`);
  };

  /** A share card's bytes, and where it is published: share/<name>-<hash of its bytes>.<ext>. */
  const readCard = (file) => {
    let card = cards.get(file);
    if (!card) {
      const source = readFileSync(resolve(config.root, file));
      const hash = createHash("sha256").update(source).digest("hex").slice(0, 8);
      const ext = extname(file);
      card = { source, published: `share/${basename(file, ext)}-${hash}${ext}` };
      cards.set(file, card);
    }
    return card;
  };

  /** @returns {import("./head.ts").SiteContext} */
  const context = () => ({
    ...SITE,
    url: siteUrl,
    // The dev server serves the file where it lies; a build gets the full public address,
    // which is what the sites that fetch link previews need.
    cardUrl: (card) => (config.command === "serve" ? config.base + card.file : siteUrl + readCard(card.file).published),
  });

  /** The HTML pages this build ships, relative to the repo root. */
  const builtPages = () => {
    const input = config.build.rollupOptions.input;
    const files = typeof input === "string" ? [input] : Array.isArray(input) ? input : Object.values(input ?? {});
    return new Set(files.map((file) => slashed(relative(config.root, resolve(config.root, file)))));
  };

  return {
    name: "strata-site",

    configResolved(resolved) {
      config = resolved;
      // The Pages workflow passes the address it is deploying to; everywhere else the table's default stands.
      siteUrl = (process.env.STRATA_SITE_URL?.trim() || SITE.url).replace(/\/*$/, "/");
    },

    transformIndexHtml: {
      // After Vite has added its own tags, so the head is final when the page's tags go in.
      order: "post",
      handler(html, ctx) {
        const file = slashed(relative(config.root, ctx.filename));
        const page = PAGES.find((row) => row.file === file);
        if (!page) return html; // dev-only demos keep whatever head they wrote
        const out = applyHead(html, page, context());
        if (out.replaced.length > 0) {
          note(`${file}: ${out.replaced.join(", ")} come from src/site/pages.ts. The copies in the HTML are ignored; delete them.`, "warn");
        }
        return out.html;
      },
    },

    generateBundle() {
      const built = builtPages();
      const shipped = PAGES.filter((page) => built.has(page.file));
      for (const file of built) {
        if (file.endsWith(".html") && !PAGES.some((page) => page.file === file)) {
          note(`${file} ships without a title, description or link preview. Give it a row in src/site/pages.ts.`, "warn");
        }
      }
      for (const page of PAGES) {
        if (!built.has(page.file)) note(`src/site/pages.ts lists ${page.file}, which vite.config.ts does not build.`, "warn");
      }

      const cardFiles = new Set(shipped.map((page) => (page.card ?? SITE.card).file));
      for (const file of cardFiles) {
        const card = readCard(file);
        this.emitFile({ type: "asset", fileName: card.published, source: card.source });
      }
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemapXml(siteUrl, shipped) });
      // Crawlers only read robots.txt at the root of a host. Under aptyll.github.io/Strata/ it
      // would do nothing, so it is written only once the site has a domain of its own.
      if (new URL(siteUrl).pathname === "/") {
        this.emitFile({ type: "asset", fileName: "robots.txt", source: `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n` });
      }
    },

    writeBundle(_options, bundle) {
      const html = bundle["index.html"];
      if (!html || html.type !== "asset") return;
      // Vite lists every statically imported chunk as a modulepreload link, so the page's
      // own references are exactly what a browser fetches before the app can start.
      const text = String(html.source);
      const files = [{ name: "index.html", bytes: gzipSync(text).length }];
      for (const [, url] of text.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
        const name = url.startsWith(config.base) ? url.slice(config.base.length) : url.replace(/^\//, "");
        const item = bundle[name];
        if (item) files.push({ name, bytes: gzipSync(item.type === "chunk" ? item.code : item.source).length });
      }
      const total = files.reduce((sum, file) => sum + file.bytes, 0);
      const line = `landing page: ${files.length} requests, ${kB(total)} kB gzipped before the first frame (budget ${LANDING_BUDGET_KB} kB)`;
      if (total <= LANDING_BUDGET_KB * 1024) return note(line);
      const largest = files.sort((a, b) => b.bytes - a.bytes).slice(0, 3);
      note(
        `${line}. Largest: ${largest.map((file) => `${file.name} ${kB(file.bytes)} kB`).join(", ")}. ` +
          `If a library is imported at the top of a file the app boots from, import() it where it is used.`,
        "warn",
      );
    },
  };
}
