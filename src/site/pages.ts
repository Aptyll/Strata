/**
 * What the published site says about itself: one row per page that ships.
 *
 * The site plugin (./plugin.mjs) turns each row into that page's <title>, its
 * description, the link preview tags that chat apps and social sites read
 * (Open Graph and X cards), a canonical address and a line in sitemap.xml.
 * Those tags are written here and not in the HTML files, so a page's wording
 * is one edit and every page says the same kind of thing. A copy of one of
 * these tags left in an HTML file is ignored, and the build says so.
 *
 * Wording rules (CLAUDE.md): realtime particles are "simulated". The trillion
 * is "rendered", never "simulated". Numbers are ones a GPU tallied.
 * site.test.mjs checks the lengths and the simulated/rendered rule.
 */

export interface ShareCard {
  /** The image, relative to the repo root. 1200x630 is what Open Graph and X both expect. */
  file: string;
  width: number;
  height: number;
  /** Read out by screen readers where the preview is shown. Say what the picture shows. */
  alt: string;
  /**
   * The render manifest of the frame on the card, relative to the repo root.
   * With it, a test checks that the particle counts in `alt` are the ones the
   * GPU counted for that frame, so the card cannot drift from its frame.
   */
  manifest?: string;
}

export interface SitePage {
  /** The HTML file, relative to the repo root: a page vite.config.ts lists, or a standalone page in docs/explainers. */
  file: string;
  /** <title> and the headline of a link preview. Search results cut it at about 60 characters. */
  title: string;
  /** Meta description and the text under the headline. Search results cut it at about 160 characters. */
  description: string;
  /** false keeps a tool or test page out of search results and out of the sitemap. Default true. */
  index?: boolean;
  /** Adds schema.org data describing the site as a web application. Only the front page needs it. */
  app?: boolean;
  /** Preview image for this page. Default: SITE.card. */
  card?: ShareCard;
}

export const SITE = {
  name: "Strata",
  /**
   * Public address of the site root, with a trailing slash. Link previews and
   * canonical links need full addresses. The Pages workflow passes the real
   * one in STRATA_SITE_URL, so a custom domain needs no edit here.
   */
  url: "https://aptyll.github.io/Strata/",
  repo: "https://github.com/Aptyll/Strata",
  author: { name: "Aptyll", url: "https://github.com/Aptyll" },
  license: "https://opensource.org/license/mit",
  locale: "en_US",
  /**
   * Made by share/make-card.py from docs/record/trillion64-A.png. The two numbers on it are GPU
   * counts read from that frame's render manifest (./README.md, "The share card").
   */
  card: {
    file: "src/site/share/strata-1t.jpg",
    width: 1200,
    height: 630,
    alt:
      "One frame of 1,000,000,000,000 particles rendered by Strata, white on black: a spiral disc, " +
      "a tower of looping ribbons and a sheet of fine rings. 985,878,422,357 of the particles are in the frame.",
    manifest: "docs/record/trillion64-A.manifest.json",
  } satisfies ShareCard,
};

/**
 * What index.html may load before the first frame: its own bytes plus every
 * script and stylesheet it references, gzipped, in kB. Every build prints the
 * real figure (about 113 kB on 2026-11-19) and warns above this one. It is a
 * tripwire for a large library imported at the top of a file the app boots
 * from, not a target: raise it on purpose when the app itself has grown.
 */
export const LANDING_BUDGET_KB = 200;

export const PAGES: SitePage[] = [
  {
    file: "index.html",
    title: "Strata: one trillion particles, rendered in a browser",
    description:
      "A particle world on WebGPU: millions simulated live in your browser, and a trillion rendered offline " +
      "into a single 4K frame. Black void, white particles.",
    app: true,
  },
  {
    file: "src/challenge/index.html",
    title: "Strata Challenge: how many particles can your GPU run?",
    description:
      "Ramps the particle count until the frame rate falls to the target, then shows the count and the " +
      "tier your GPU reached. Every particle is simulated, every frame.",
  },
  {
    file: "src/offline/web/index.html",
    title: "Strata offline renderer: a trillion particles per frame",
    description:
      "Renders stateless particles into exact 64-bit counts, up to 1,000,000,000,000 per 4K frame, then " +
      "exports PNG frames or an MP4. Runs in Chrome on WebGPU.",
  },
  {
    file: "src/proof/web/index.html",
    title: "Strata proof shots: is the trillion real?",
    description:
      "Renders that test the claim: a count-up, a pull-back from one particle, one pixel opened up, " +
      "an unbroken dive, and a flight to particle 999,999,999,999.",
  },
  {
    file: "src/perf/bench/index.html",
    title: "Strata benchmark: particles per second on your GPU",
    description:
      "Runs the 8-byte particle engine on your GPU and reports frame rate and particles per second, " +
      "with a sweep from 1 million to 800 million simulated particles.",
  },
  {
    file: "src/color-life/demo/index.html",
    title: "Strata color life: particle life with color species",
    description:
      "Each particle's color is its rule: a rolled matrix says how hard each color pulls or pushes the " +
      "others. Clusters, chains and cells emerge. Simulated on the GPU.",
  },
  {
    file: "src/stateless/demo/index.html",
    title: "Strata stateless motion: particles with nothing stored",
    description:
      "One sheet, one closed-form law: a veil, a spiral galaxy, a cosmic web or folded ribbons. Every frame " +
      "computes each particle's position from scratch.",
  },
  {
    file: "src/ux/design/demo/index.html",
    title: "Strata design tokens",
    description: "Every design token of Strata's interface in use: type roles, ink levels, spacing, motion and the theme accent.",
    index: false,
  },
  {
    file: "docs/explainers/rendering.html",
    title: "How Strata draws a trillion particles: a field guide",
    description:
      "An interactive explainer: one particle's trip to a pixel, the memory wall, atomic counters, tone " +
      "mapping and render time. Plain language, white on black.",
  },
  {
    file: "src/verify/index.html",
    title: "Strata shader checks",
    description: "Compiles Strata's shaders in your browser and compares what they compute with a CPU reference.",
    index: false,
  },
];
