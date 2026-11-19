# site

What the published site says about itself, and how fast its front page loads.
Nothing in here runs in the app: it is build-time code and a few images.

| file | what it is |
| --- | --- |
| `pages.ts` | the table: one row per page that ships, with its title and description, plus the site's address, share card and load budget |
| `head.ts` | turns a row into tags (title, description, canonical, Open Graph, X card, schema.org data) and writes them into a page's HTML |
| `plugin.mjs` | the Vite plugin that `vite.config.ts` loads: applies the tags in dev and build, publishes the share card, writes `sitemap.xml`, prints the landing page's weight |
| `share/strata-1t.jpg` | the share card, 1200x630, made by `share/make-card.py` |
| `site.test.mjs` | unit tests (`npm test -- site`) |

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
pasted link. It is a real frame, `docs/record/trillion-A.png`, scaled down
with only empty rows and columns trimmed, and the two numbers on it are that
frame's GPU tallies: 1,000,000,000,000 particles evaluated and 985,878,512,802
landed in the frame. To change it, edit `share/make-card.py` (frame, numbers,
type) and run it; it needs Python with Pillow and the Inter font.

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
