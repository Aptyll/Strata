// @ts-check
/**
 * A render folder (job.json, frame-NNNNNN.json and .png, written by
 * src/offline) to its manifest. Plain Node, no GPU: shared by record.mjs and
 * reproduce.mjs.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildManifest, sha256OfBytes, sha256OfText } from "../manifest.mjs";
import { gitCommit, hostInfo, shown } from "./common.mjs";

/** @param {string} file */
export const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/**
 * The video's name, size and SHA-256, streamed: a 4K master can be large.
 * @param {string} file
 */
export async function videoInfo(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { file: path.basename(file), bytes, sha256: hash.digest("hex") };
}

/**
 * Write the job a manifest embeds as <out>/job.json, byte for byte as it was
 * rendered: the text must hash to the manifest's job.sha256. Plain Node, no
 * GPU and no tsx, so it runs on any machine; the folder then renders in
 * /src/offline/web/. A folder that already holds the same job is left as it
 * is, so a stopped render can continue.
 * @param {string} file manifest.json
 * @param {string} out folder
 */
export async function jobFromManifest(file, out) {
  const m = await readJson(file);
  if (m?.kind !== "strata-render-manifest") throw new Error(`${shown(file)} is not a render manifest.`);
  if (!m.fullJob) throw new Error(`${shown(file)} does not embed its job (fullJob is null).`);
  const text = JSON.stringify(m.fullJob);
  const sha = await sha256OfText(text);
  if (sha !== m.job.sha256) {
    throw new Error(`The job in ${shown(file)} hashes to ${sha.slice(0, 12)}, not the ${String(m.job.sha256).slice(0, 12)} the manifest claims, so the file was edited. Not writing it.`);
  }
  await mkdir(out, { recursive: true });
  const target = path.join(out, "job.json");
  if (!existsSync(target)) await writeFile(target, text);
  else if ((await readFile(target, "utf8")) !== text) throw new Error(`${shown(target)} holds another job. Use an empty folder.`);
  return { job: m.fullJob, file: target, sha256: sha };
}

/**
 * @param {string} dir
 * @param {{ gpu?: any, look?: any, entry?: string, mp4?: string }} extra
 */
export async function makeManifest(dir, extra = {}) {
  const job = await readJson(path.join(dir, "job.json"));
  const names = (await readdir(dir)).filter((n) => /^frame-\d+\.json$/.test(n)).sort();
  const stats = [];
  /** @type {Record<number, string>} */
  const imageSha256 = {};
  for (const n of names) {
    const s = await readJson(path.join(dir, n));
    stats.push(s);
    const png = path.join(dir, n.replace(/\.json$/, ".png"));
    if (existsSync(png)) imageSha256[s.frame] = await sha256OfBytes(new Uint8Array(await readFile(png)));
  }
  if (!stats.length) throw new Error(`No finished frames (frame-*.json) in ${dir}`);
  let gpu = extra.gpu ?? null;
  if (!gpu && existsSync(path.join(dir, "adapter.json"))) gpu = await readJson(path.join(dir, "adapter.json"));
  // The video: --mp4, or <job name>.mp4 in the folder, where the Node encoder and the offline page put it by default.
  const mp4 = extra.mp4 ?? (existsSync(path.join(dir, `${job.name}.mp4`)) ? path.join(dir, `${job.name}.mp4`) : null);
  const host = hostInfo();
  const manifest = await buildManifest({
    job,
    stats,
    imageSha256,
    commit: gitCommit(),
    renderer: "src/offline StatelessRenderer",
    entry: extra.entry ?? null,
    gpu,
    host: { platform: host.platform, node: host.node },
    look: extra.look ?? null,
    video: mp4 ? await videoInfo(mp4) : null,
  });
  const file = path.join(dir, "manifest.json");
  await writeFile(file, JSON.stringify(manifest, null, 2));
  return { manifest, file };
}

