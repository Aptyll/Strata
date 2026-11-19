# site

What the published site says about itself, what it is allowed to talk to, and
how fast its front page loads. Nothing in here runs in the app: it is
build-time code and a few images.

| file | what it is |
| --- | --- |
| `pages.ts` | the table: one row per page that ships, with its title and description, plus the site's address, share card and load budget |
| `head.ts` | the privacy lock (a Content-Security-Policy), and the tags built from a row (title, description, canonical, Open Graph, X card, schema.org data); both are written into a page's HTML here |
| `plugin.mjs` | the Vite plugin that `vite.config.ts` loads: locks and tags every page in dev and build, publishes the `docs/explainers` pages and the share card, writes `sitemap.xml`, prints the landing page's weight |
| `share/strata-1t.jpg` | the share card, 1200x630, made by `share/make-card.py` |
| `site.test.mjs` | unit tests (`npm test -- site`) |

## The privacy lock

The site has no analytics, no cookies and no third-party requests, and the
browser enforces it. Every page gets this tag right after its charset
declaration, from `contentSecurityPolicy()` in `head.ts`:

```
default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:;
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:;
font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:;
object-src 'none'; base-uri 'self'; form-action 'self'
```

`'self'` is the site's own address; `data:` and `blob:` are bytes the page
already holds. No other host is named, and a test fails if one ever is. So a
script from a CDN, a web font from another server, an analytics beacon or a
`fetch` to another site is refused, whoever adds it, and the console says
which rule refused it. The dev server gets the same policy (plus `ws:` for
live reload), so a violation shows up while developing and not after a deploy.
`npm run smoke` opens every built page and fails on a refused request, so in
CI a pull request that adds one turns red.

What it means when you build something:

- Bundle what you need, or load it with `import()`. System fonts only, or
  font files in the repo.
- No `eval` or `new Function`. Inline `<script>` and `<style>` are fine.
- A link to another site is not a request, so links out are always fine. To
  show a video, put its poster image in the repo and link the image to the
  video: nothing is fetched from the video host until someone clicks, and the
  page stays light.
- Letting a third party in, for example a video player embedded in the page,
  means adding its host to one directive in `head.ts` on purpose, and changing
  the README's privacy paragraph to say so.

It is a lock against leaks, not a defence against injected script. And it
cannot hide a visitor from the host: GitHub Pages serves the files and sees
the IP address of whoever asks for them.

Standalone pages in `docs/explainers` are not built by Vite, so the plugin
publishes them itself, with the lock on. A stylesheet link or connection hint
to another server is left out of the published copy (the build log names the
host), which is why the rendering explainer shows system fonts on the live
site and not the Google Fonts its source file links.

## Change what a page says

Edit its row in `pages.ts`. The title is the browser tab, the search result
headline and the headline of a link preview; the description is the text
under it. Do not put these tags in the HTML file: a `description`, `robots`,
`og:*`, `twitter:*` or canonical tag found there is dropped in favour of the
table, and the build prints which. Everything else in a page's head (viewport,
icon, theme color, styles) stays the page's own.

A page added to `vite.config.ts` needs a row here too. Until it has one the
build says so and the page ships with whatever head it wrote.

The tests hold the copy to three rules: titles up to 60 characters,
descriptions 50 to 160, and no clause that calls the trillion "simulated"
(it is rendered).

## The share card

`share/strata-1t.jpg` is the picture chat apps and social sites show next to a
pasted link. It is a real frame, `docs/record/trillion-key2-f0.png`, scaled
down with only empty rows and columns trimmed (and the bottom darkened behind
the type). The two numbers on it are the ones on that frame's own label, and
they are not the same kind of number:

- **107,787,615,440 in this frame** is the GPU's count of the particles that
  landed in the picture.
- **1,000,000,000,000** is the particle count of the render job. Every
  position is computed, because the renderer culls nothing, but this still was
  most likely rendered before the renderer counted evaluated particles on the
  GPU, so it is not a GPU count
  ([journal, page 07](../../docs/journal/rendering/2026-11-18-07-first-trillion-frames.md)).

When a frame re-rendered on current main, with a manifest, replaces this one,
build the card from it: then both numbers are GPU counts. The card used to be
`trillion-A.png`, which is not a trillion distinct particles (see
`docs/record/README.md`). To change it, edit `share/make-card.py` (frame,
numbers, type) and run it; it needs Python with Pillow and the Inter font.

The published file name contains a hash of the image's bytes
(`share/strata-1t-<hash>.jpg`). Sites that show previews cache the image by
address for days or weeks, so a changed card must have a new address or the
old picture sticks. A page can have its own card: give its row a `card`.

To see a preview after a deploy, paste the page's address into the LinkedIn
Post Inspector or the Facebook Sharing Debugger (both also refresh their
cache), or into a private chat on Slack, Discord or iMessage. X has no
checker any more; a draft post shows the card.

## The site's address

Link previews and canonical links need full addresses. `SITE.url` in
`pages.ts` is the default, and the Pages workflow passes the address it is
deploying to in `STRATA_SITE_URL`, so a custom domain needs no edit here.
`robots.txt` is only written when the site sits at a domain's root, because
crawlers do not read it anywhere else; under `aptyll.github.io/Strata/` the
sitemap is found by submitting `sitemap.xml` in Google Search Console.

## The load budget

Every build prints one line:

```
[site] landing page: 16 requests, 112.9 kB gzipped before the first frame (budget 200 kB)
```

That is `index.html` plus every script and stylesheet it references, which is
what a browser fetches before the app can start. Above `LANDING_BUDGET_KB` the
line becomes a warning that names the three largest files. The usual cause is
a library imported at the top of a file the app boots from; load it with
`import()` where it is used, the way `src/capture/recorder.ts` loads its MP4
muxer (that one change took 56 kB off the page). The budget is a tripwire,
not a target: raise it on purpose when the app itself has grown.

## By hand on GitHub

Two things only the repository owner can set, both on the repo page:

- **About** (the gear next to it): a description, the website address and
  topics such as `webgpu`, `particles`, `typescript`. GitHub search and search
  engines read these.
- **Settings, General, Social preview**: upload a 1280x640 image. It is the
  picture shown when someone shares the repository's address.
  `python3 src/site/share/make-card.py --all <folder>` writes one.
