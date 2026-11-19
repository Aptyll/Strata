/**
 * Verify page entry. Runs every registered case against a real WebGPU device
 * and prints a plain report. The finished report is also left on
 * `window.__verify` for the headless runner (src/verify/run.mjs).
 *
 * URL parameters: ?filter=text keeps cases whose file or name contains text.
 */

import { TOKENS } from "../core/contracts";
import { acquireDevice, type VerifyDevice } from "./gpu";
import { collectCases } from "./registry";
import { VerifySkip, type VerifyContext, type VerifyReport, type VerifyResult } from "./types";

declare global {
  interface Window {
    __verify?: VerifyReport;
  }
}

const out = document.createElement("pre");
Object.assign(document.body.style, { margin: "0", background: TOKENS.color.background, color: TOKENS.color.foreground });
Object.assign(out.style, {
  margin: "0",
  padding: `${TOKENS.unit * 4}px`,
  font: TOKENS.font,
  letterSpacing: TOKENS.letterSpacing,
  opacity: `${TOKENS.opacityStrong}`,
  whiteSpace: "pre-wrap",
});
document.body.append(out);
const print = (line = ""): void => {
  out.textContent += `${line}\n`;
};

function indent(text: string): string {
  return text.split("\n").map((l) => `      ${l}`).join("\n");
}

async function runAll(): Promise<VerifyReport> {
  const report: VerifyReport = { done: false, adapter: "none", software: false, results: [], passed: 0, failed: 0, skipped: 0 };
  let gpu: VerifyDevice;
  try {
    gpu = await acquireDevice();
  } catch (e) {
    report.results.push({ file: "src/verify", name: "acquire WebGPU device", status: "fail", ms: 0, message: String(e), notes: [] });
    report.failed = 1;
    print(`FAIL  no WebGPU device: ${e}`);
    report.done = true;
    return report;
  }
  report.adapter = gpu.description;
  report.software = gpu.software;
  print(`adapter  ${gpu.description}${gpu.software ? "  (software: results are valid, timings are not)" : ""}`);
  print(`limits   buffer ${gpu.device.limits.maxBufferSize}  storage binding ${gpu.device.limits.maxStorageBufferBindingSize}`);
  print();

  let uncaptured: string[] = [];
  gpu.device.onuncapturederror = (ev) => {
    uncaptured.push(ev.error.message);
  };
  let lost: string | null = null;
  void gpu.device.lost.then((info) => {
    lost = `device lost: ${info.message || info.reason}`;
  });

  const filter = new URLSearchParams(location.search).get("filter")?.toLowerCase() ?? "";
  const cases = (await collectCases()).filter((c) => `${c.file} ${c.case.name}`.toLowerCase().includes(filter));

  let lastFile = "";
  for (const { file, case: c } of cases) {
    if (file !== lastFile) {
      print(file);
      lastFile = file;
    }
    const result: VerifyResult = { file, name: c.name, status: "pass", ms: 0, notes: [] };
    const context: VerifyContext = {
      adapter: gpu.adapter,
      device: gpu.device,
      software: gpu.software,
      note: (message) => {
        result.notes.push(message);
      },
      skip: (reason) => {
        throw new VerifySkip(reason);
      },
    };
    uncaptured = [];
    const start = performance.now();
    try {
      if (lost) throw new Error(lost);
      await c.run(context);
      // Flush the queue so errors raised by this case are attributed to it.
      await gpu.device.queue.onSubmittedWorkDone();
      if (uncaptured.length > 0) throw new Error(`uncaptured GPU error: ${uncaptured.join("\n")}`);
    } catch (e) {
      if (e instanceof VerifySkip) {
        result.status = "skip";
        result.message = e.message;
      } else {
        result.status = "fail";
        result.message = e instanceof Error ? e.message : String(e);
      }
    }
    result.ms = Math.round(performance.now() - start);
    report.results.push(result);
    if (result.status === "pass") report.passed++;
    else if (result.status === "fail") report.failed++;
    else report.skipped++;
    print(`  ${result.status.toUpperCase().padEnd(4)}  ${c.name}  (${result.ms} ms)`);
    if (result.message) print(indent(result.message));
    for (const n of result.notes) print(indent(`note: ${n}`));
  }
  print();
  print(`${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
  report.done = true;
  return report;
}

runAll().then(
  (report) => {
    window.__verify = report;
    document.title = report.failed > 0 ? `verify: ${report.failed} failed` : "verify: ok";
  },
  (e) => {
    print(`FAIL  harness crashed: ${e}`);
    window.__verify = {
      done: true, adapter: "none", software: false, passed: 0, failed: 1, skipped: 0,
      results: [{ file: "src/verify/main.ts", name: "harness", status: "fail", ms: 0, message: String(e), notes: [] }],
    };
  },
);
