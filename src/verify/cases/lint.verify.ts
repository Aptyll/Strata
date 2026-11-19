/** Each lint rule fires on the mistake it names and stays quiet on the fix. */

import { LINT_RULE_IDS, lintWgsl, stripComments } from "../lint";
import { VerifyError, type VerifyCase } from "../types";

interface Sample {
  rule: (typeof LINT_RULE_IDS)[number];
  bad: string[];
  good: string[];
}

const SAMPLES: Sample[] = [
  {
    rule: "workgroup-size",
    bad: ["@compute @workgroup_size(512) fn main() {}", "@compute @workgroup_size(32, 16) fn main() {}", "@compute @workgroup_size(1, 1, 128) fn main() {}"],
    good: ["@compute @workgroup_size(256) fn main() {}", "@compute @workgroup_size(16, 16) fn main() {}", "@compute @workgroup_size(WG) fn main() {}"],
  },
  {
    rule: "rand-reaches-one",
    bad: [
      "fn rand(h: u32) -> f32 { return f32(h) / 4294967296.0; }",
      "fn rand(h: u32) -> f32 { return f32(pcg(h ^ seed)) / 4294967295.0; }",
      "fn rand(h: u32) -> f32 { return f32(h) * (1.0 / 4294967296.0); }",
      "fn rand(h: u32) -> f32 { return f32(h) * 2.3283064365386963e-10; }",
    ],
    good: ["fn rand(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }", "fn rand(h: u32) -> f32 { return f32(h >> 8u) / 16777216.0; }"],
  },
  {
    rule: "index-to-f32",
    bad: ["let t = f32(i) * 0.001;", "let u = f32(gid.x) / f32(count);", "let a = f32(in.vertex_index);", "let b = f32( idx );"],
    good: ["let t = f32(i & 0xffffu) * 0.001;", "let w = f32(width);", "let k = f32(iterations);"],
  },
  {
    rule: "unguarded-dispatch",
    bad: [
      `@compute @workgroup_size(64)
       fn main(@builtin(global_invocation_id) gid: vec3u) {
         particles[gid.x] = step(particles[gid.x]);
       }`,
    ],
    good: [
      `@compute @workgroup_size(64)
       fn main(@builtin(global_invocation_id) gid: vec3u) {
         if (gid.x >= plane.count) { return; }
         particles[gid.x] = step(particles[gid.x]);
       }`,
      `@compute @workgroup_size(8, 8)
       fn main(@builtin(global_invocation_id) gid: vec3u) {
         if (all(gid.xy < size)) { textureStore(dst, gid.xy, vec4f(1.0)); }
       }`,
      "@compute @workgroup_size(1) fn main() { counter = 0u; }",
    ],
  },
  {
    rule: "nonatomic-accumulate",
    bad: [
      "@group(0) @binding(0) var<storage, read_write> grid: array<u32>;\nfn f(c: u32) { grid[c] += 1u; }",
      "@group(0) @binding(0) var<storage, read_write> density: array<f32>;\nfn f(c: u32, w: f32) { density[cell(c)] = density[cell(c)] + w; }",
      "@group(0) @binding(0) var<storage, read_write> field: array<vec2f>;\nfn f(c: u32) { field[c].x += 1.0; }",
    ],
    good: [
      "@group(0) @binding(0) var<storage, read_write> grid: array<atomic<u32>>;\nfn f(c: u32) { atomicAdd(&grid[c], 1u); }",
      "@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;\nfn f(i: u32) { particles[i].vel += vec2f(1.0); }",
      "@group(0) @binding(0) var<storage, read_write> grid: array<u32>;\nfn f(c: u32) { grid[c] = 0u; }",
    ],
  },
  {
    rule: "vec3-array-stride",
    bad: ["@group(0) @binding(0) var<storage, read> positions: array<vec3f>;", "@group(0) @binding(0) var<storage, read_write> v: array<vec3<f32>>;"],
    good: ["@group(0) @binding(0) var<storage, read> positions: array<vec4f>;", "fn f() { var local: array<vec3f, 4>; }"],
  },
];

const cases: VerifyCase[] = [
  {
    name: "every rule has samples",
    run() {
      const covered = new Set(SAMPLES.map((s) => s.rule));
      for (const id of LINT_RULE_IDS) if (!covered.has(id)) throw new VerifyError(`no samples for rule ${id}`);
    },
  },
  ...SAMPLES.map(
    (sample): VerifyCase => ({
      name: `${sample.rule} fires on the mistake and not on the fix`,
      run() {
        for (const code of sample.bad) {
          if (!lintWgsl(code).some((f) => f.rule === sample.rule)) throw new VerifyError(`missed:\n${code}`);
        }
        for (const code of sample.good) {
          const hit = lintWgsl(code).find((f) => f.rule === sample.rule);
          if (hit) throw new VerifyError(`false positive (${hit.message}):\n${code}`);
        }
      },
    }),
  ),
  {
    name: "comments are ignored and verify-ok silences a finding",
    run() {
      const commented = "// let t = f32(i);\n/* grid[c] += 1u; /* nested */ f32(h) / 4294967296.0 */\nlet x = 1.0;";
      if (stripComments(commented).split("\n").length !== 3) throw new VerifyError("stripComments changed the line count");
      if (lintWgsl(commented).length !== 0) throw new VerifyError("linted inside a comment");
      const sameLine = "let t = f32(i) * 0.5; // verify-ok: index-to-f32 (count is below 65536)";
      const lineAbove = "// verify-ok: index-to-f32\nlet t = f32(i) * 0.5;";
      const otherRule = "let t = f32(i) * 0.5; // verify-ok: rand-reaches-one";
      if (lintWgsl(sameLine).length !== 0 || lintWgsl(lineAbove).length !== 0) throw new VerifyError("verify-ok did not silence");
      if (lintWgsl(otherRule).length !== 1) throw new VerifyError("verify-ok for another rule silenced this one");
      const finding = lintWgsl("let a = 1.0;\nlet t = f32(i);")[0];
      if (finding.line !== 2) throw new VerifyError(`line ${finding.line}, expected 2`);
    },
  },
];

export default cases;
