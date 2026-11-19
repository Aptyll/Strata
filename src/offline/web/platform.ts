/** Browser implementations of the FileStore and Zlib interfaces from ../core. */
import type { Zlib } from "../core/png";
import type { FileStore } from "../core/session";

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** "deflate" in the Compression Streams spec is the zlib format, which PNG uses. */
export const browserZlib: Zlib = {
  deflate: (data) => pipe(data, new CompressionStream("deflate")),
  inflate: (data) => pipe(data, new DecompressionStream("deflate")),
};

/**
 * A folder on disk the user picked. createWritable() writes to a temporary
 * file and swaps it in on close, so writes are atomic.
 */
export function directoryStore(dir: FileSystemDirectoryHandle): FileStore {
  return {
    async read(name) {
      try {
        const handle = await dir.getFileHandle(name);
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch (e) {
        if ((e as DOMException).name === "NotFoundError") return null;
        throw e;
      }
    },
    async write(name, data) {
      const handle = await dir.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      await w.write(data as BlobPart);
      await w.close();
    },
    async remove(name) {
      await dir.removeEntry(name).catch(() => {});
    },
  };
}

/** Kept in memory: nothing survives a reload. For browsers without folder access. */
export function memoryStore(): FileStore {
  const files = new Map<string, Uint8Array>();
  return {
    read: async (name) => files.get(name) ?? null,
    write: async (name, data) => void files.set(name, data.slice()),
    remove: async (name) => void files.delete(name),
  };
}

export const canPickFolder = (): boolean => typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  return picker({ id: "strata-offline", mode: "readwrite" });
}
