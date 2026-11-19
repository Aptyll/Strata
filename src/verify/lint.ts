/**
 * Static checks for WGSL source text. Pure functions, no GPU needed.
 *
 * The WGSL compiler already rejects code that is invalid. These rules look
 * for code that compiles and is still wrong or fragile at very large particle
 * counts. They are pattern matches, not a parser, so each rule is written to
 * stay quiet unless the pattern is a well-known mistake.
 *
 * Silence a finding that was checked by hand with a comment on the same line
 * or the line above:   // verify-ok: <rule-id>
 */

import { WEBGPU_DEFAULT_LIMITS } from "./limits";

export type LintSeverity = "error" | "warn";

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  /** 1-based line in the source that was linted. */
  line: number;
  message: string;
  /** The offending source line, trimmed. */
  source: string;
}

/** Replaces comments with spaces, keeping every newline so line numbers hold. */
export function stripComments(code: string): string {
  let out = "";
  let i = 0;
  let depth = 0;
  while (i < code.length) {
    const two = code.startsWith("/*", i) ? "/*" : code.startsWith("*/", i) ? "*/" : code.startsWith("//", i) ? "//" : "";
    if (depth === 0 && two === "//") {
      while (i < code.length && code[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (two === "/*") {
      depth++;
      out += "  ";
      i += 2;
    } else if (depth > 0 && two === "*/") {
      depth--;
      out += "  ";
      i += 2;
    } else {
      out += depth > 0 && code[i] !== "\n" ? " " : code[i];
      i++;
    }
  }
  return out;
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (code.charCodeAt(i) === 10) line++;
  return line;
}

/** Returns the index just past the bracket that closes the one at `open`. */
function matchBracket(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const openChar = code[open];
  const closeChar = pairs[openChar];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === openChar) depth++;
    else if (code[i] === closeChar && --depth === 0) return i + 1;
  }
  return code.length;
}

type Report = (rule: string, severity: LintSeverity, index: number, message: string) => void;

/** @workgroup_size beyond the default limits fails pipeline creation on a default device. */
function ruleWorkgroupSize(code: string, report: Report): void {
  for (const m of code.matchAll(/@workgroup_size\s*\(([^)]*)\)/g)) {
    const dims = m[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (!dims.every((d) => /^\d+[ui]?$/.test(d))) continue; // override constants: cannot tell statically
    const [x, y = 1, z = 1] = dims.map((d) => parseInt(d, 10));
    const L = WEBGPU_DEFAULT_LIMITS;
    if (x > L.maxComputeWorkgroupSizeX || y > L.maxComputeWorkgroupSizeY || z > L.maxComputeWorkgroupSizeZ) {
      report("workgroup-size", "error", m.index, `@workgroup_size(${dims.join(", ")}) exceeds the per-axis limits (256, 256, 64)`);
    } else if (x * y * z > L.maxComputeInvocationsPerWorkgroup) {
      report(
        "workgroup-size",
        "error",
        m.index,
        `@workgroup_size(${dims.join(", ")}) is ${x * y * z} invocations, above maxComputeInvocationsPerWorkgroup (256)`,
      );
    }
  }
}

/**
 * f32(hash) / 2^32 returns exactly 1.0 for the top hash values, because f32(h)
 * rounds up to 2^32 (for 128 to 255 values, depending on how the GPU rounds).
 * A [0, 1) generator must use 24 bits: f32(h >> 8u) * (1.0 / 16777216.0).
 */
function ruleRandReachesOne(code: string, report: Report): void {
  const arg = String.raw`f32\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)`;
  const two32 = String.raw`(?:4294967295|4294967296)(?:\.\d*)?f?\b`;
  const patterns = [
    new RegExp(`${arg}\\s*/\\s*${two32}`, "g"),
    new RegExp(`${arg}\\s*\\*\\s*\\(?\\s*1(?:\\.0*)?f?\\s*/\\s*${two32}`, "g"),
    new RegExp(`${arg}\\s*\\*\\s*2\\.3283\\d*e-10`, "g"),
    /\b2\.3283\d*e-10f?\s*\*\s*f32\s*\(/g,
  ];
  const seen = new Set<number>();
  for (const p of patterns) {
    for (const m of code.matchAll(p)) {
      if (seen.has(m.index)) continue;
      seen.add(m.index);
      report(
        "rand-reaches-one",
        "error",
        m.index,
        "u32 to float by dividing by 2^32 returns exactly 1.0 once per 17 to 33 million draws, because f32 rounds the top values up to 2^32. Use f32(h >> 8u) * (1.0 / 16777216.0).",
      );
    }
  }
}

/** f32 holds integers exactly only up to 16,777,216. Particle indices go far beyond that here. */
function ruleIndexToF32(code: string, report: Report): void {
  const names = "i|idx|index|id|pid|particle_index|particleIndex|vertex_index|vertexIndex|instance_index|instanceIndex";
  const re = new RegExp(String.raw`\bf32\s*\(\s*(?:\w+\.)?(?:(?:${names})|(?:gid|id|global_id|globalId|global_invocation_id)\.x)\s*\)`, "g");
  for (const m of code.matchAll(re)) {
    report(
      "index-to-f32",
      "warn",
      m.index,
      "an index converted to f32 loses its low bits above 16,777,216, so neighbouring particles collapse onto the same value. Hash the u32, or split it into two 16 bit halves.",
    );
  }
}

/**
 * The last workgroup of a dispatch overshoots the item count. Without an
 * early return those invocations step inactive particles, and past the end
 * of the buffer the index is clamped so they all write the last element.
 */
function ruleUnguardedDispatch(code: string, report: Report): void {
  for (const m of code.matchAll(/@compute\b/g)) {
    const fn = /\bfn\s+(\w+)\s*\(/g;
    fn.lastIndex = m.index;
    const f = fn.exec(code);
    if (!f) continue;
    const paramsEnd = matchBracket(code, fn.lastIndex - 1);
    const params = code.slice(fn.lastIndex, paramsEnd);
    const bodyStart = code.indexOf("{", paramsEnd);
    if (bodyStart < 0) continue;
    const body = code.slice(bodyStart, matchBracket(code, bodyStart));
    if (!/global_invocation_id/.test(params) && !/global_invocation_id/.test(code.slice(m.index, bodyStart))) continue;
    // Either `if (i >= n) { return; }` or the whole body inside `if (i < n) { ... }`.
    const guarded = /\bif\b[^{;]*(>=|<=|<|>|\bany\s*\(|\ball\s*\()/.test(body);
    if (!guarded) {
      report(
        "unguarded-dispatch",
        "warn",
        f.index,
        `compute entry point "${f[1]}" has no bounds check for invocations past the item count. The last workgroup overshoots, and out-of-range writes may be clamped onto the last element.`,
      );
    }
  }
}

/**
 * `grid[cell] += x` on a plain storage array is a read-modify-write. When two
 * invocations hit the same cell one update is lost, differently every frame.
 */
function ruleNonAtomicAccumulate(code: string, report: Report): void {
  const decl = /var\s*<\s*storage\s*,\s*read_write\s*>\s*(\w+)\s*:\s*array\s*<\s*([^;]*?)\s*>\s*;/g;
  for (const d of code.matchAll(decl)) {
    const name = d[1];
    const element = d[2].split(",")[0].trim();
    if (!/^(u32|i32|f32|vec[234][uif]|vec[234]\s*<\s*[uif]32\s*>)$/.test(element)) continue; // atomics and structs
    const use = new RegExp(String.raw`\b${name}\s*\[`, "g");
    for (const u of code.matchAll(use)) {
      const end = matchBracket(code, u.index + u[0].length - 1);
      const indexExpr = code.slice(u.index + u[0].length, end - 1).trim();
      const after = code.slice(end, end + 200);
      const compound = /^\s*(?:\.\w+\s*)?(\+=|-=|\*=|\|=|&=|\^=|<<=|>>=)/.exec(after);
      const self = new RegExp(String.raw`^\s*=\s*${name}\s*\[\s*${indexExpr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*\]\s*[-+*|&^]`).test(after);
      if (compound || self) {
        report(
          "nonatomic-accumulate",
          "warn",
          u.index,
          `"${name}" is accumulated without atomics. If two invocations can reach the same element, updates are lost. Declare it array<atomic<u32>> and use atomicAdd, or prove each invocation owns its element.`,
        );
      }
    }
  }
}

/** array<vec3f> in a buffer has a 16 byte stride, not 12. A common CPU/GPU layout mismatch. */
function ruleVec3Array(code: string, report: Report): void {
  const re = /var\s*<\s*(?:storage|uniform)[^>]*>\s*\w+\s*:\s*array\s*<\s*(vec3[uifh]|vec3\s*<\s*\w+\s*>)/g;
  for (const m of code.matchAll(re)) {
    report(
      "vec3-array-stride",
      "warn",
      m.index,
      "array<vec3> in a buffer uses 16 bytes per element, not 12. Use vec4, or three scalars, and make sure the CPU side writes the same stride.",
    );
  }
}

const RULES: readonly ((code: string, report: Report) => void)[] = [
  ruleWorkgroupSize,
  ruleRandReachesOne,
  ruleIndexToF32,
  ruleUnguardedDispatch,
  ruleNonAtomicAccumulate,
  ruleVec3Array,
];

/** The ids of every rule, for documentation and tests. */
export const LINT_RULE_IDS = [
  "workgroup-size",
  "rand-reaches-one",
  "index-to-f32",
  "unguarded-dispatch",
  "nonatomic-accumulate",
  "vec3-array-stride",
] as const;

/** Runs every rule over one WGSL source and returns the findings in source order. */
export function lintWgsl(source: string): LintFinding[] {
  const code = stripComments(source);
  const lines = source.split("\n");
  const findings: LintFinding[] = [];
  const report: Report = (rule, severity, index, message) => {
    const line = lineOf(code, index);
    const here = lines[line - 1] ?? "";
    const above = lines[line - 2] ?? "";
    const allow = new RegExp(String.raw`verify-ok:[^\n]*\b${rule}\b`);
    if (allow.test(here) || allow.test(above)) return;
    findings.push({ rule, severity, line, message, source: here.trim() });
  };
  for (const rule of RULES) rule(code, report);
  return findings.sort((a, b) => a.line - b.line);
}

/** One line per finding, for reports. */
export function formatFindings(findings: readonly LintFinding[]): string {
  return findings.map((f) => `${f.severity} ${f.rule} at line ${f.line}: ${f.message}\n    ${f.source}`).join("\n");
}
