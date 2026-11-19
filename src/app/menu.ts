/**
 * The Esc menu's table of contents: every control, in the order it appears,
 * with its page, its section and the name it goes by. Read MENU top to bottom
 * and you have read the menu.
 *
 * Controls are registered wherever they are built (hud.registerParam in
 * src/ux/hud/wire.ts, ./hud.ts, src/capture, src/record, src/ux/theme, ...).
 * This table has the last word on where each one appears and what it is
 * called, so the menu can be read, reordered and renamed in one file, the way
 * KEYS in ./keys.ts lists every key. Ids are the stable handle: other code
 * talks to a control by id (hud.setParam, hud.getParam) and never by label.
 *
 * How a page is laid out:
 *   - Every page but "behaviors" is stacked: its sections show one under the
 *     other with a small title, so a setting and the button that uses it are
 *     on screen together. "behaviors" keeps section tabs, because its
 *     sections are alternatives (one per behavior) and each is long.
 *   - A section with `fold` starts folded behind its title. Each stacked page
 *     ends with a folded "advanced" section for controls most people never
 *     need.
 *
 * A control that is not listed still shows up: it keeps the `group` it
 * registered with, joins the section of that name on the page that lists the
 * group (after the listed rows), and lands on "more" when no page does.
 * `group: "advanced"` with a `page` puts it in that page's folded section.
 * To place a control exactly, add a row here.
 *
 * Wording: the app simulates its particles, the record job renders stateless
 * ones. Titles and hints keep the two apart (CLAUDE.md, "Honest counting").
 */
import type { MenuLayout, MenuPage as HudMenuPage, ParamPlacement } from "../ux/hud/index.js";

export interface MenuRow {
  /** The id the control registers with (hud.registerParam, registerJob). */
  id: string;
  /** The name shown. Default: the label the control registered with. */
  label?: string;
  /** One line for the row's tooltip: what it does, in plain words. */
  hint?: string;
  /** Id of a switch this control depends on. It is dimmed while that switch is off. */
  needs?: string;
}

export interface MenuSection {
  /** Group name, lower case. An unlisted control that registers with this `group` joins the section. */
  group: string;
  /** The section's title, when the group name is not what people should read. */
  label?: string;
  /** Start folded behind the title. */
  fold?: boolean;
  rows?: MenuRow[];
}

export interface MenuPage {
  id: string;
  /** Text on the page tab. Six tabs fit on one line, so keep these short. */
  label: string;
  /** Section tabs instead of stacked sections. */
  tabs?: boolean;
  sections: MenuSection[];
  /** Other group names that land on this page, after the sections above. */
  also?: string[];
}

/** Destinations outside the world. Registered by registerMenuLinks below. */
const LINKS = {
  bench: "open.bench",
  offline: "open.offline",
  proof: "open.proof",
} as const;

export const MENU: MenuPage[] = [
  {
    id: "scene",
    label: "scene",
    sections: [
      {
        group: "world",
        rows: [
          { id: "particles", hint: "Particles stored on the GPU, across all sheets. A sheet in view steps its particles every frame; a sheet out of view rests." },
          { id: "planes", hint: "Flat sheets in the world. Each one runs its own 2D particle system." },
          { id: "interplane", hint: "Particles leave one sheet and land on a neighbour." },
          { id: "share", label: "copy link to this world", hint: "Copies a link that replays this dice roll and color theme." },
        ],
      },
      {
        group: "camera",
        rows: [
          { id: "autocam", hint: "The camera flies itself between dense sheets. Any camera input takes over." },
          { id: "parallax", hint: "The view slides a little with the pointer, for a sense of depth." },
        ],
      },
      {
        group: "sound",
        rows: [
          { id: "sound", label: "soundtrack", hint: "A quiet ambient sound that follows what is on screen. Rendered videos carry it while it is on." },
          { id: "sound.volume", needs: "sound" },
        ],
      },
    ],
    also: ["scene", "share"],
  },
  {
    // One section of sliders per behavior in the world, registered with page "behaviors" (src/ux/hud/wire.ts).
    id: "behaviors",
    label: "behaviors",
    tabs: true,
    sections: [],
    also: ["behaviors", "behavior"],
  },
  {
    id: "look",
    label: "look",
    sections: [
      {
        group: "look",
        rows: [
          { id: "brightness", hint: "Light each particle adds." },
          { id: "white", hint: "How dense particles must get to reach full white. Higher keeps detail in dense cores." },
          { id: "contrast", hint: "Darkens the dim areas so dense structure stands out. 1 is the plain curve." },
          { id: "bloom", hint: "A soft glow around the brightest areas." },
          { id: "trails", hint: "Particles leave fading streaks." },
          {
            id: "depth",
            label: "fog and focus",
            hint: "Depth cues: far sheets fade into fog and sheets out of focus blur. Works with the default drawing mode.",
          },
        ],
      },
      {
        group: "advanced",
        fold: true,
        rows: [
          {
            id: "subpixel",
            label: "sub-pixel smoothing",
            hint: "Spreads each particle over the four pixels around it, so slow motion glides instead of stepping. Four writes per particle; default drawing mode only.",
          },
        ],
      },
    ],
    also: ["render", "depth"],
  },
  {
    id: "color",
    label: "color",
    sections: [
      {
        group: "color",
        rows: [{ id: "theme", label: "theme", hint: "Maps brightness to a color ramp. It costs nothing per particle." }],
      },
    ],
    also: ["theme", "themes", "colour"],
  },
  {
    id: "perf",
    label: "perf",
    sections: [
      // The perf.* rows are live readouts (src/ux/perf-hud): each sits above the controls it reacts to.
      // A row whose control is not registered is skipped, and a section with no rows does not show.
      { group: "timing", rows: [{ id: "perf.timing" }] },
      {
        group: "performance",
        label: "frame rate",
        rows: [
          { id: "adaptive", hint: "Uses fewer particles when the frame rate falls below the target." },
          { id: "targetFps", needs: "adaptive", hint: "The frame rate to hold." },
          { id: "perf.fit" },
          { id: "hud.fpsCorner", hint: "A small fps and frame time readout in the top left corner." },
        ],
      },
      { group: "particles", rows: [{ id: "perf.particles" }] },
      {
        group: "tests",
        label: "test this gpu",
        rows: [
          {
            id: "challenge",
            label: "open challenge mode",
            hint: "Leaves this world. How many particles can this GPU hold at a target frame rate?",
          },
          {
            id: LINKS.bench,
            label: "open the benchmark",
            hint: "Leaves this world. Measures this GPU from 1 million to 800 million particles.",
          },
        ],
      },
      { group: "gpu", fold: true, rows: [{ id: "perf.gpu" }] },
      {
        group: "advanced",
        fold: true,
        rows: [
          {
            id: "rasterizer",
            label: "draw with",
            hint: "How particles are drawn. Compute is the fast default; the others are for comparison and debugging.",
          },
        ],
      },
    ],
    also: ["perf", "display"],
  },
  {
    id: "capture",
    label: "capture",
    sections: [
      {
        // Shared by everything below: the trillion render reads these three too.
        group: "output",
        rows: [
          { id: "capture.size", hint: "Size of stills, videos and trillion renders." },
          { id: "capture.fps", hint: "Frames per second of rendered videos and clips." },
          { id: "capture.seconds", hint: "Length of a rendered video or clip." },
        ],
      },
      {
        group: "capture",
        label: "this world (simulated)",
        rows: [
          { id: "capture.still", hint: "Renders this world at the resolution above and saves a PNG." },
          {
            id: "capture.video",
            hint: "Renders this world frame by frame at the settings above and saves an MP4, with the soundtrack if sound is on. Press again to cancel.",
          },
        ],
      },
      {
        group: "record",
        label: "trillion (rendered)",
        rows: [
          {
            id: "record.particles",
            label: "particles",
            hint: "Stateless particles: each position is computed from its id and the time, nothing is stored. Rendered offline, not simulated.",
          },
          { id: "record.shot", label: "shot", hint: "Which view of the rendered world to frame." },
          { id: "record.clip", label: "clip instead of a still", hint: "Renders a clip of the length above instead of one frame." },
          {
            id: "record",
            label: "render",
            hint: "Renders that many particles offline at the resolution above. It is not the world on screen, which pauses meanwhile.",
          },
          {
            id: LINKS.offline,
            label: "open the offline renderer",
            hint: "Leaves this world. The full tool for record renders: presets, a folder for the frames, MP4 export.",
          },
          {
            id: LINKS.proof,
            label: "open the proof shots",
            hint: "Leaves this world. Shots that show the trillion particles are distinct: count-up, pull-back, loupe, dive, find.",
          },
        ],
      },
      {
        group: "advanced",
        fold: true,
        rows: [
          {
            id: "capture.supersample",
            hint: "Stills and videos of this world: render at twice the size and scale down, for smoother edges.",
          },
          {
            id: "capture.disk",
            label: "save video straight to disk",
            hint: "Writes the video to a file you pick while it renders, so a long video does not have to fit in memory.",
          },
        ],
      },
    ],
  },
  // Whatever no page lists, each group under its own title. Must stay last.
  { id: "more", label: "more", sections: [] },
];

/** The table in the shape the HUD takes: createHud({ layout: menuLayout() }). */
export function menuLayout(pages: readonly MenuPage[] = MENU): MenuLayout {
  const params: Record<string, ParamPlacement> = {};
  const hudPages: HudMenuPage[] = pages.map((page) => {
    for (const section of page.sections) {
      (section.rows ?? []).forEach(({ id, ...row }, order) => {
        params[id] = { page: page.id, group: section.group, order, ...row };
      });
    }
    // Sections in table order, then the page's other groups. On a stacked page "advanced" always
    // comes last and folded, and is there as soon as a control asks for it.
    const groups = [...page.sections.map((s) => s.group), ...(page.also ?? [])].filter((g) => g !== "advanced");
    const fold = page.sections.filter((s) => s.fold && s.group !== "advanced").map((s) => s.group);
    if (!page.tabs) {
      groups.push("advanced");
      fold.push("advanced");
    }
    return {
      id: page.id,
      label: page.label,
      stack: !page.tabs,
      groups,
      labels: Object.fromEntries(page.sections.flatMap((s) => (s.label ? [[s.group, s.label]] : []))),
      fold,
    };
  });
  return { pages: hudPages, params };
}

/**
 * Menu rows that lead to the app's other pages (the list in vite.config.ts).
 * The app had no way to reach them. Their place in the menu is in MENU above.
 */
export function registerMenuLinks(hud: { registerParam(spec: { id: string; label: string; type: "action"; run: () => void }): unknown }): void {
  // Pages sit next to index.html in dev and in the build, whatever base path the site is served from.
  const open = (path: string) => () => location.assign(new URL(path, document.baseURI));
  hud.registerParam({ id: LINKS.bench, label: "open the benchmark", type: "action", run: open("src/perf/bench/") });
  hud.registerParam({ id: LINKS.offline, label: "open the offline renderer", type: "action", run: open("src/offline/web/") });
  hud.registerParam({ id: LINKS.proof, label: "open the proof shots", type: "action", run: open("src/proof/web/") });
}
