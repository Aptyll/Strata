/**
 * Builds the tags a page's <head> gets from its row in ./pages.ts, and puts
 * them into the page's HTML. No DOM and no Node here: strings in, strings out,
 * so the plugin, the dev server and the tests all share it.
 */
import type { ShareCard, SitePage } from "./pages";

/** What the plugin knows at build time and the table cannot. */
export interface SiteContext {
  name: string;
  /** Site root, absolute, with a trailing slash. */
  url: string;
  repo: string;
  author: { name: string; url: string };
  license: string;
  locale: string;
  /** Full address of the published card image for `page`. */
  cardUrl(card: ShareCard): string;
  card: ShareCard;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "index.html" is the site root; "src/challenge/index.html" is "src/challenge/". */
export function pageUrl(siteUrl: string, file: string): string {
  return siteUrl + file.replace(/(^|\/)index\.html$/, "$1");
}

function imageType(file: string): string {
  if (/\.jpe?g$/i.test(file)) return "image/jpeg";
  if (/\.png$/i.test(file)) return "image/png";
  if (/\.webp$/i.test(file)) return "image/webp";
  throw new Error(`site: share card ${file} must be a .jpg, .png or .webp (link previews do not read other formats)`);
}

/** Every tag the table owns for one page, in the order they are written. */
export function headTags(page: SitePage, site: SiteContext): string[] {
  const url = pageUrl(site.url, page.file);
  const card = page.card ?? site.card;
  const image = site.cardUrl(card);
  const meta = (attr: "name" | "property", key: string, content: string | number) =>
    `<meta ${attr}="${key}" content="${escapeHtml(String(content))}" />`;

  const tags = [
    `<title>${escapeHtml(page.title)}</title>`,
    meta("name", "description", page.description),
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
  ];
  if (page.index === false) tags.push(meta("name", "robots", "noindex"));
  tags.push(
    // Open Graph: Facebook, LinkedIn, Slack, Discord, iMessage, WhatsApp, Mastodon, Bluesky.
    meta("property", "og:type", "website"),
    meta("property", "og:site_name", site.name),
    meta("property", "og:title", page.title),
    meta("property", "og:description", page.description),
    meta("property", "og:url", url),
    meta("property", "og:image", image),
    meta("property", "og:image:type", imageType(card.file)),
    meta("property", "og:image:width", card.width),
    meta("property", "og:image:height", card.height),
    meta("property", "og:image:alt", card.alt),
    meta("property", "og:locale", site.locale),
    // X reads the Open Graph tags above for everything except these two.
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:image:alt", card.alt),
  );
  if (page.app) {
    const data = {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: site.name,
      url,
      description: page.description,
      image,
      applicationCategory: "MultimediaApplication",
      operatingSystem: "Any",
      browserRequirements: "Requires WebGPU",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      license: site.license,
      sameAs: site.repo,
      author: { "@type": "Person", name: site.author.name, url: site.author.url },
    };
    // "<" is escaped so no text in the data can close the script element.
    tags.push(`<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`);
  }
  return tags;
}

/** A <meta> or <link> tag, with quoted attribute values that may contain ">". */
const TAG = /<(meta|link)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>/]+))`, "i").exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3]).toLowerCase() : null;
}

/**
 * The name of a tag the table owns (description, robots, og:*, twitter:*,
 * canonical), or null for a tag that belongs to the page (viewport, icon,
 * theme-color and so on).
 */
function ownedTag(tagName: string, attrs: string): string | null {
  if (tagName.toLowerCase() === "link") return attribute(attrs, "rel") === "canonical" ? "canonical" : null;
  const name = attribute(attrs, "name");
  if (name === "description" || name === "robots" || name?.startsWith("twitter:")) return name;
  const property = attribute(attrs, "property");
  return property?.startsWith("og:") ? property : null;
}

export interface HeadResult {
  html: string;
  /** Names of the tags found in the page's own HTML and dropped in favour of the table's. */
  replaced: string[];
}

/** Stands in for a removed tag until the lines left empty by removals are dropped. */
const REMOVED = "\u0000";

/**
 * Writes `page`'s tags into `html`. They take the place of the page's own
 * <title> (or go last in <head> if it has none), one per line, indented like
 * the tags around them. Copies of owned tags already in the HTML are removed.
 */
export function applyHead(html: string, page: SitePage, site: SiteContext): HeadResult {
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd < 0) throw new Error(`site: ${page.file} has no </head>, so its tags have nowhere to go`);
  let head = html.slice(0, headEnd);
  const rest = html.slice(headEnd);

  const replaced: string[] = [];
  head = head.replace(TAG, (tag: string, tagName: string, attrs: string) => {
    const owned = ownedTag(tagName, attrs);
    if (!owned) return tag;
    replaced.push(owned);
    return REMOVED;
  });
  // A removed tag takes its line with it when nothing else was on that line.
  head = head.replace(/^[ \t]*(?:\u0000[ \t]*)+\r?\n/gm, "").split(REMOVED).join("");

  const indent = /^([ \t]*)<(?:meta|link|title)\b/im.exec(head)?.[1] ?? "";
  const tags = headTags(page, site);
  const title = /[ \t]*<title\b[^>]*>[\s\S]*?<\/title>/i.exec(head);
  if (title) {
    const block = tags.map((tag) => indent + tag).join("\n");
    head = head.slice(0, title.index) + block + head.slice(title.index + title[0].length);
  } else {
    // No <title>: last in <head>, in front of whatever indents the closing tag.
    const tail = /[ \t]*$/.exec(head)![0];
    const body = head.slice(0, head.length - tail.length);
    head = body + (body.endsWith("\n") ? "" : "\n") + tags.map((tag) => indent + tag + "\n").join("") + tail;
  }
  return { html: head + rest, replaced };
}

/** sitemap.xml for the pages search engines should list. */
export function sitemapXml(siteUrl: string, pages: SitePage[]): string {
  const urls = pages
    .filter((page) => page.index !== false)
    .map((page) => `  <url><loc>${escapeHtml(pageUrl(siteUrl, page.file))}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
