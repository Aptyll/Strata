/**
 * Ready-made cases for whole shaders: compile with the real WGSL compiler,
 * then run the static lint rules.
 */

import { compile } from "./gpu";
import { formatFindings, lintWgsl } from "./lint";
import { VerifyError, type VerifyCase } from "./types";

export interface ShaderCaseOptions {
  /** Skip compilation, for snippets that are not complete modules. Lint still runs. */
  lintOnly?: boolean;
  /** Lint warnings fail the case too. Default: only lint errors fail, warnings become notes. */
  strict?: boolean;
}

/**
 * A case that passes when `code` compiles without errors and the lint finds
 * no errors. Compiler warnings and lint warnings are attached as notes.
 *
 * `code` may be a function so that shader assembly runs inside the case and
 * an exception there is reported as a failure of this case only.
 */
export function shaderCase(name: string, code: string | (() => string), options: ShaderCaseOptions = {}): VerifyCase {
  return {
    name,
    async run(t) {
      const source = typeof code === "function" ? code() : code;
      if (!options.lintOnly) {
        const { warnings } = await compile(t.device, source, name);
        for (const w of warnings) t.note(`compiler ${w}`);
      }
      const findings = lintWgsl(source);
      const failing = findings.filter((f) => options.strict || f.severity === "error");
      if (failing.length > 0) throw new VerifyError(formatFindings(failing));
      for (const f of findings) t.note(formatFindings([f]));
    },
  };
}
