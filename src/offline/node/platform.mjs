// @ts-check
/** Node implementations of the FileStore and Zlib interfaces from ../core. */
import { mkdirSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

/** @type {import("../core/png").Zlib} */
export const nodeZlib = {
  // Level 1: frames are mostly noise or black, higher levels cost time for little gain.
  deflate: async (data) => deflateSync(data, { level: 1 }),
  inflate: async (data) => inflateSync(data),
};

/**
 * @param {string} dir
 * @returns {import("../core/session").FileStore}
 */
export function nodeStore(dir) {
  mkdirSync(dir, { recursive: true });
  return {
    async read(name) {
      try {
        return new Uint8Array(await readFile(path.join(dir, name)));
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
        throw e;
      }
    },
    async write(name, data) {
      // Write beside the target, then rename: a reader never sees half a file.
      const target = path.join(dir, name);
      const temp = `${target}.tmp`;
      await writeFile(temp, data);
      await rename(temp, target);
    },
    async remove(name) {
      await rm(path.join(dir, name), { force: true });
    },
  };
}
