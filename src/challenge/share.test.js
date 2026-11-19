// What Challenge mode says about a run, checked by `npm test`. No GPU, no DOM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { challengeLink, gpuName, rendererName, resultSentence, viewerText, worldLink } from "./share";

/**
 * A finished, valid, simulated run. Each test changes what it is about. The
 * GPU's own count equals the count that ran unless a test sets `gpuCount`.
 */
const run = (result = {}, facts = {}) => ({
  phase: "hold",
  mismatches: 0,
  memoryLimited: false,
  software: false,
  lost: null,
  ...facts,
  result: {
    mode: "sim",
    particles: 142_606_336,
    fps: 30.4,
    targetFps: 30,
    sustained: true,
    stoppedBy: "fps",
    width: 1920,
    height: 1080,
    planes: 24,
    particlesPerPixel: 68.8,
    bytesPerParticle: 8,
    gpuMs: 29.1,
    gpuCount: result.particles ?? 142_606_336,
    gpuCountVerified: true,
    tier1: true,
    adapter: "nvidia turing",
    gpuName: "NVIDIA GeForce RTX 2070",
    workgroupSize: 256,
    ...result,
  },
});

test("a finished run states the count, that it is simulated, and the frame rate measured at that count", () => {
  const t = viewerText(run());
  assert.equal(t.figure, "142,606,336");
  assert.equal(t.what, "particles simulated every frame at 30.4 fps");
  assert.equal(t.caption, "the most this GPU holds at 30 fps · tier 1 reached");
  assert.equal(t.conditions, "NVIDIA GeForce RTX 2070 · 1920x1080 · 24 sheets");
  assert.equal(t.over, true);
  assert.equal(t.shareable, true);
});

test("while the search runs, the frame rate is live and never attached to the count", () => {
  for (const phase of ["climb", "refine", "confirm"]) {
    const t = viewerText(run({ sustained: false, stoppedBy: null, tier1: false, particles: 33_554_432, fps: 61.2 }, { phase }));
    assert.equal(t.figure, "33,554,432");
    assert.equal(t.what, "particles simulated every frame");
    assert.equal(t.caption, "finding the most this GPU holds at 30 fps");
    assert.equal(t.conditions, "61.2 fps · 1920x1080 · 24 sheets");
    assert.equal(t.over, false);
    assert.equal(t.shareable, false, "nothing to copy before the search is done");
  }
  const first = viewerText(run({ sustained: false, tier1: false, particles: 0, fps: 0, gpuCount: null }, { phase: "climb" }));
  assert.equal(first.figure, "--");
  assert.match(first.conditions, /^-- fps/);
});

test("the number on screen is the GPU's own count, not the count that was asked for", () => {
  const searching = { sustained: false, stoppedBy: null, tier1: false, fps: 52 };
  // The search asked for more, and the GPU's latest checked frame still ran the count before.
  const asked = viewerText(run({ ...searching, particles: 41_943_040, gpuCount: 33_554_432 }, { phase: "climb" }));
  assert.equal(asked.figure, "33,554,432");
  // No checked frame yet in this run: no number, whatever was asked for.
  const unchecked = viewerText(run({ ...searching, particles: 41_943_040, gpuCount: null }, { phase: "climb" }));
  assert.equal(unchecked.figure, "--");
  // A finished run whose latest checked frame came up short shows what the GPU did, with no frame rate attached.
  const short = viewerText(run({ gpuCount: 142_000_000, gpuCountVerified: false, tier1: false }, { mismatches: 1 }));
  assert.equal(short.figure, "142,000,000");
  assert.equal(short.what, "particles simulated every frame");
  assert.equal(short.caption, "result invalid: the GPU counted a different number");
  assert.equal(short.shareable, false);
});

test("every count says simulated or rendered, in every state", () => {
  const states = [
    {},
    { phase: "climb" },
    { phase: "fixed" },
    { lost: "device hung" },
    { mismatches: 2 },
    { software: true },
    { memoryLimited: true },
  ];
  for (const mode of ["sim", "proc"]) {
    for (const facts of states) {
      const t = viewerText(run({ mode }, facts));
      assert.match(t.what, mode === "sim" ? /\bsimulated\b/ : /\brendered\b.*not simulated/, JSON.stringify({ mode, facts }));
    }
  }
});

test("procedural mode is never called simulated, on screen or in the sentence", () => {
  const facts = run({ mode: "proc", particles: 2_147_483_648, fps: 31, tier1: false, bytesPerParticle: 0 });
  assert.equal(viewerText(facts).what, "particles rendered every frame at 31.0 fps, not simulated");
  const s = resultSentence(facts, "https://example.org/?challenge");
  assert.match(s, /^Strata challenge, procedural mode: 2,147,483,648 particles rendered every frame at 31\.0 fps, not simulated /);
  assert.doesNotMatch(s.replace("not simulated", ""), /simulated/);
});

test("a run that ended for another reason than frame rate says so", () => {
  const ceiling = { stoppedBy: "ceiling", tier1: false };
  assert.equal(viewerText(run(ceiling, { memoryLimited: true })).caption, "limited by GPU memory, not by frame rate");
  assert.equal(viewerText(run(ceiling)).caption, "the most this mode can run, not the limit of this GPU");
  const floor = viewerText(run({ sustained: false, stoppedBy: "floor", tier1: false, particles: 65_536, fps: 12.3 }));
  assert.equal(floor.caption, "this GPU cannot hold 30 fps here");
  assert.equal(floor.what, "particles simulated every frame", "no frame rate is claimed for a count that did not hold");
  assert.equal(floor.shareable, false);
  assert.equal(floor.over, true);
});

test("a result is only offered for copying when the GPU's own count matched", () => {
  assert.equal(viewerText(run({ gpuCountVerified: false, tier1: false })).shareable, false);
  const off = viewerText(run({ gpuCountVerified: false, tier1: false }, { mismatches: 3 }));
  assert.equal(off.shareable, false);
  assert.equal(off.caption, "result invalid: the GPU counted a different number");
  const lost = viewerText(run({}, { lost: "device hung" }));
  assert.equal(lost.shareable, false);
  assert.equal(lost.over, true);
  assert.equal(lost.caption, "the graphics device stopped");
  const midSearch = viewerText(run({ sustained: false, tier1: false, fps: 48 }, { phase: "climb", lost: "device hung" }));
  assert.equal(midSearch.what, "particles simulated in the last frame", "a count the search never measured claims no frame rate");
  assert.equal(viewerText(run({ fps: 0, sustained: false, tier1: false }, { phase: "fixed" })).shareable, false, "not measured yet");
});

test("a fixed count reports its live frame rate and says it was not a search", () => {
  const facts = run({ sustained: false, stoppedBy: null, tier1: false, particles: 100_007_936, fps: 44 }, { phase: "fixed" });
  const t = viewerText(facts);
  assert.equal(t.what, "particles simulated every frame at 44.0 fps");
  assert.equal(t.caption, "fixed count, no search");
  assert.equal(t.over, false);
  assert.equal(t.shareable, true);
  assert.match(resultSentence(facts, "x"), /at 44\.0 fps, fixed count \(1920x1080, 24 sheets\)/);
});

test("a CPU renderer is named as one, so a small number is not blamed on the graphics card", () => {
  const facts = run({ tier1: false, particles: 3_276_800, gpuName: "SwiftShader Device (Subzero)" }, { software: true });
  assert.equal(viewerText(facts).caption, "running on the CPU: this browser is not using a graphics card");
  assert.match(resultSentence(facts, "x"), /sheets\) on a software renderer \(no graphics card\)\. x$/);
});

test("the sentence for a comment reads as one line with the conditions and the link", () => {
  assert.equal(
    resultSentence(run(), "https://aptyll.github.io/Strata/?challenge"),
    "Strata challenge: 142,606,336 particles simulated every frame at 30.4 fps (1920x1080, 24 sheets) on NVIDIA GeForce RTX 2070. https://aptyll.github.io/Strata/?challenge",
  );
  assert.match(resultSentence(run({ stoppedBy: "ceiling" }, { memoryLimited: true }), "x"), /fps, limited by GPU memory \(/);
  assert.match(resultSentence(run({ gpuName: "" }), "x"), /24 sheets\)\. x$/, "an unknown GPU is left out, not guessed");
});

test("a shared result points at the standard challenge, and the way back keeps the app's own options", () => {
  assert.equal(challengeLink("https://aptyll.github.io/Strata/?challenge=&fps=60&planes=48#r=7"), "https://aptyll.github.io/Strata/?challenge");
  assert.equal(challengeLink("https://aptyll.github.io/Strata/src/challenge/?mode=proc"), "https://aptyll.github.io/Strata/src/challenge/");

  assert.equal(worldLink("https://aptyll.github.io/Strata/?challenge"), "https://aptyll.github.io/Strata/");
  assert.equal(
    worldLink("https://aptyll.github.io/Strata/?theme=red&particles=4000000&challenge=&mode=proc&res=4k#r=7"),
    "https://aptyll.github.io/Strata/?theme=red&particles=4000000#r=7",
  );
  assert.equal(worldLink("https://aptyll.github.io/Strata/src/challenge/?count=100M"), "https://aptyll.github.io/Strata/");
  assert.equal(worldLink("http://localhost:5173/src/challenge/index.html"), "http://localhost:5173/");
  assert.equal(worldLink("http://localhost:5173/elsewhere.html"), "http://localhost:5173/");
});

test("a WebGL renderer string is cut down to the name of the card", () => {
  const cases = {
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 (0x00001F02) Direct3D11 vs_5_0 ps_5_0, D3D11)": "NVIDIA GeForce RTX 2070",
    "ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)": "Intel UHD Graphics 630",
    "ANGLE (AMD, AMD Radeon RX 6800 XT (0x000073BF) Direct3D11 vs_5_0 ps_5_0, D3D11)": "AMD Radeon RX 6800 XT",
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)": "Apple M1 Pro",
    "ANGLE (Apple, Apple M2, OpenGL 4.1)": "Apple M2",
    "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3080/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 535.54.03)": "NVIDIA GeForce RTX 3080",
    "ANGLE (NVIDIA, Vulkan 1.3.242 (NVIDIA NVIDIA GeForce RTX 3070 (0x00002484)), NVIDIA-535.54.3.0)": "NVIDIA GeForce RTX 3070",
    "ANGLE (AMD, AMD Radeon RX 6800 XT (radeonsi, navi21, LLVM 15.0.7, DRM 3.49, 6.2.0-39-generic), OpenGL 4.6)": "AMD Radeon RX 6800 XT",
    "ANGLE (Qualcomm, Vulkan 1.3.128 (Adreno (TM) 740 (0x43050A01)), Qualcomm-0.676.22)": "Adreno 740",
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)": "SwiftShader Device (Subzero)",
    "ANGLE (Samsung Electronics Co., Ltd., ANGLE (Samsung Xclipse 920) on Vulkan 1.1.179, OpenGL ES 3.2)": "Samsung Xclipse 920",
    "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0)": "NVIDIA GeForce GTX 980",
    "Adreno (TM) 740": "Adreno 740",
    "Mali-G78 MC14": "Mali-G78 MC14",
    "Apple GPU": "Apple GPU",
  };
  for (const [renderer, name] of Object.entries(cases)) assert.equal(rendererName(renderer), name, renderer);
});

test("WebGL's name is used only when it is the same vendor as the WebGPU adapter", () => {
  const nvidia = "ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 (0x00001F02) Direct3D11 vs_5_0 ps_5_0, D3D11)";
  const intel = "ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)";
  const adapter = { vendor: "nvidia", architecture: "turing", device: "", description: "" };

  assert.deepEqual(gpuName({ adapter, renderer: nvidia }), { name: "NVIDIA GeForce RTX 2070", software: false });
  // A laptop with two cards: WebGL on the Intel one, WebGPU on the NVIDIA one.
  assert.deepEqual(gpuName({ adapter, renderer: intel }), { name: "nvidia turing", software: false });
  // Firefox names a stand-in model for a whole family of cards.
  assert.deepEqual(gpuName({ adapter, renderer: nvidia, rendererIsStandIn: true }), { name: "nvidia turing", software: false });
  assert.deepEqual(gpuName({ adapter, renderer: null }), { name: "nvidia turing", software: false });
  // An adapter that says nothing cannot contradict WebGL, and nothing at all stays empty.
  assert.deepEqual(gpuName({ adapter: {}, renderer: nvidia }), { name: "NVIDIA GeForce RTX 2070", software: false });
  assert.deepEqual(gpuName({ adapter: {}, renderer: null }), { name: "", software: false });
  // Phones: the vendor is "qualcomm", the card is an "Adreno".
  assert.equal(gpuName({ adapter: { vendor: "qualcomm" }, renderer: "Adreno (TM) 740" }).name, "Adreno 740");
  assert.equal(gpuName({ adapter: { vendor: "apple", architecture: "metal-3" }, renderer: "Apple GPU" }).name, "Apple GPU");
});

test("a CPU renderer is recognised by its flag or by its name", () => {
  const swift = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
  assert.equal(gpuName({ adapter: { vendor: "google", architecture: "swiftshader" }, renderer: swift }).software, true);
  assert.equal(gpuName({ adapter: { vendor: "microsoft", description: "Microsoft Basic Render Driver" }, renderer: null }).software, true);
  assert.equal(gpuName({ adapter: { vendor: "intel" }, renderer: null, fallbackAdapter: true }).software, true);
  assert.equal(gpuName({ adapter: { vendor: "nvidia", architecture: "turing" }, renderer: null }).software, false);
});
