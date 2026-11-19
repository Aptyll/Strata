/**
 * Collects verify cases from the whole source tree.
 *
 * - Every `src/**\/*.verify.ts` file: default export is a VerifyCase or an array of them.
 * - Every `src/**\/*.wgsl` file: linted, and compiled if it declares an entry
 *   point. A file that is only a fragment of a module (it relies on a prelude
 *   that is concatenated at runtime) opts out of compilation with a first
 *   line `// verify: fragment`.
 */

import { shaderCase } from "./shader-case";
import type { VerifyCase } from "./types";

export interface RegisteredCase {
  file: string;
  case: VerifyCase;
}

type CaseModule = { default?: VerifyCase | VerifyCase[] };

export async function collectCases(): Promise<RegisteredCase[]> {
  const out: RegisteredCase[] = [];

  const caseModules = import.meta.glob<CaseModule>("/src/**/*.verify.ts");
  for (const file of Object.keys(caseModules).sort()) {
    const name = file.replace(/^\//, "");
    try {
      const mod = await caseModules[file]();
      const cases = mod.default === undefined ? [] : Array.isArray(mod.default) ? mod.default : [mod.default];
      if (cases.length === 0) {
        out.push({ file: name, case: { name: "exports cases", run: () => { throw new Error("no default export of VerifyCase or VerifyCase[]"); } } });
      }
      for (const c of cases) out.push({ file: name, case: c });
    } catch (e) {
      // A file that fails to load must show up as a failure, not vanish.
      out.push({ file: name, case: { name: "loads", run: () => { throw e; } } });
    }
  }

  const shaders = import.meta.glob<string>("/src/**/*.wgsl", { query: "?raw", import: "default" });
  for (const file of Object.keys(shaders).sort()) {
    const name = file.replace(/^\//, "");
    const source = await shaders[file]();
    const fragment = /^\s*\/\/\s*verify:\s*fragment\b/.test(source) || !/@(compute|vertex|fragment)\b/.test(source);
    out.push({ file: name, case: shaderCase(fragment ? "lints" : "compiles and lints", source, { lintOnly: fragment }) });
  }
  return out;
}
