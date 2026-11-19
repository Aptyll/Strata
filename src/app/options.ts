/**
 * Every URL option the app reads, parsed once at boot into plain values.
 *
 *   ?particles=4000000   particle capacity across all planes (default 2M, or 8M with ?world)
 *   &planes=48           sheets in the generated layout (default 32)
 *   &behaviors=flow,galaxy  behavior ids to cycle through (default: every registered one)
 *   &brightness=1        light per particle (default 1, or 0.2 with ?tonemap=basic)
 *   &seed=1              layout seed
 *   &raster=points       draw with the point-list pass instead of the compute rasterizer
 *   &raster=hue          points, each sheet in its own color (src/hue)
 *   &raster=sprites      depth-aware sprites: fog, depth of field, size falloff (also ?depth=1)
 *   &raster=splat        sub-pixel splats
 *   &parallax=1          the eye slides sideways with the pointer, for depth parallax
 *   &interplane=0        no particles crossing between planes
 *   &intro=0             skip the opening
 *   &adaptive=1          thin planes to hold the frame rate
 *   &fps=60              frame rate the adaptive budget aims for
 *   &world=strata        stream an endless seeded world instead of the fixed layout (docs/world.md)
 *   &challenge           open Challenge mode (src/challenge) instead of the world
 *   &record              start a record-scale still or clip as soon as the app is up
 *
 * Read elsewhere, listed here so this stays the one table to look in:
 *   &tonemap=basic       plain exponential tone map instead of the density look
 *                        (src/passes/tonemap.pass.ts)
 *   &depth=              src/passes/sprites.pass.ts reads it too, but the rasterizer
 *                        choice in src/app/graph.ts decides which rasterize pass runs
 *   &theme=red           color theme (src/ux/theme/index.ts)
 *   #r=<seed>            replay a shared dice roll (src/ux/hud/wire.ts)
 *   ?record=1e12 &size= &frames= &seconds= &fps= &sheets= &seed= &weighting= &fresh=
 *                        what the record job renders (src/record/index.ts). Note that
 *                        &fps and &seed mean something else to the app itself.
 *
 * An option the URL sets explicitly holds for that visit: the settings menu
 * neither restores a saved choice over it nor saves it (`fromUrl`, used by
 * src/app/hud.ts).
 */

export interface AppOptions {
  /** ?challenge: open Challenge mode instead of the world. */
  challenge: boolean;
  /** ?world=<seed>: seed of the endless streamed world, or null for the fixed layout. */
  world: string | null;
  /** Particle capacity across all planes. With ?world it caps the streamed world instead. */
  particles: number;
  /** Sheets in the generated layout. */
  planes: number;
  /** Behavior ids to cycle through, or null for every registered behavior. */
  behaviors: string[] | null;
  /** Light added per particle before tone mapping. */
  brightness: number;
  /** Seed of the generated layout. */
  seed: number;
  /** Short rasterizer name from the URL: "points", "sprites", "splat", or "" for the default. */
  raster: string;
  /** Start with pointer parallax on. */
  parallax: boolean;
  /** Particles cross between neighbouring planes. */
  interplane: boolean;
  /** Play the opening (it never plays with ?world). */
  intro: boolean;
  /** Start with the adaptive budget that thins planes to hold the frame rate. */
  adaptive: boolean;
  /** Frame rate the adaptive budget aims for. */
  fps: number;
  /** ?record: start the record job (src/record) once the app is up. */
  record: boolean;
  /** The options the URL set explicitly. A saved menu setting never overrides one of these. */
  fromUrl: ReadonlySet<keyof AppOptions>;
}

/** The URL keys behind each option, for `fromUrl`. ?depth=1 picks a rasterizer too. */
const URL_KEYS: Partial<Record<keyof AppOptions, readonly string[]>> = {
  world: ["world"],
  particles: ["particles"],
  planes: ["planes"],
  behaviors: ["behaviors"],
  brightness: ["brightness"],
  seed: ["seed"],
  raster: ["raster", "depth"],
  parallax: ["parallax"],
  interplane: ["interplane"],
  intro: ["intro"],
  adaptive: ["adaptive"],
  fps: ["fps"],
};

export function readOptions(search: string): AppOptions {
  const query = new URLSearchParams(search);
  /** A positive number from the URL, or the fallback when it is missing or invalid. */
  const num = (key: string, fallback: number) => {
    const v = Number(query.get(key));
    return query.has(key) && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const world = query.get("world");
  return {
    challenge: query.has("challenge"),
    // ?world with no value means the default seed.
    world: world === null ? null : world || "strata",
    particles: Math.round(num("particles", world === null ? 2_000_000 : 8_000_000)),
    planes: Math.round(num("planes", 32)),
    behaviors: query.get("behaviors")?.split(",") ?? null,
    // The density look is tuned for one unit of light per particle; the plain tone map saturates far sooner.
    brightness: num("brightness", query.get("tonemap") === "basic" ? 0.2 : 1),
    seed: Math.round(num("seed", 1)),
    raster: query.get("depth") === "1" ? "sprites" : query.get("raster") ?? "",
    parallax: query.get("parallax") === "1",
    interplane: query.get("interplane") !== "0",
    intro: query.get("intro") !== "0",
    adaptive: query.get("adaptive") === "1",
    fps: num("fps", 60),
    record: query.has("record"),
    fromUrl: new Set(
      (Object.keys(URL_KEYS) as (keyof AppOptions)[]).filter((option) => URL_KEYS[option]!.some((key) => query.has(key))),
    ),
  };
}
