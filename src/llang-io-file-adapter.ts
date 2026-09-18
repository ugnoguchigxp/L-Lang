import { randomUUID } from "node:crypto";
import {
  type FileHandle,
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { LBytes } from "./llang-effects-values";

export type FileResourceHandle = Readonly<{
  id: number;
  generation: number;
  mode: "read" | "write";
}>;

type ReadResource = {
  mode: "read";
  generation: number;
  file: FileHandle;
  offset: number;
};
type WriteResource = {
  mode: "write";
  generation: number;
  file: FileHandle;
  temporary: string;
  target: string;
  replace: boolean;
  closed: boolean;
  device: number;
  inode: number;
};
type Resource = ReadResource | WriteResource;

const inside = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
};

export class LocalFileAdapter {
  readonly #resources = new Map<number, Resource>();
  #nextId = 1;

  private constructor(readonly root: string) {}

  static async create(root: string): Promise<LocalFileAdapter> {
    const canonical = await realpath(resolve(root));
    if (!(await lstat(canonical)).isDirectory())
      throw new Error("INVALID_FILE_ROOT");
    return new LocalFileAdapter(canonical);
  }

  async openRead(path: string): Promise<FileResourceHandle> {
    const target = await this.#existing(path),
      info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("PERMISSION_DENIED");
    const file = await open(target, "r"),
      id = this.#nextId++,
      generation = 1;
    const [opened, current] = await Promise.all([file.stat(), lstat(target)]);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      await file.close();
      throw new Error("PERMISSION_DENIED: path changed");
    }
    this.#resources.set(id, { mode: "read", generation, file, offset: 0 });
    return Object.freeze({ id, generation, mode: "read" });
  }

  async readChunk(
    handle: FileResourceHandle,
    maximum = 64 * 1024,
  ): Promise<{ eof: boolean; bytes: LBytes }> {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 64 * 1024)
      throw new Error("RESOURCE_LIMIT: chunk");
    const resource = this.#get(handle, "read") as ReadResource,
      buffer = new Uint8Array(maximum),
      result = await resource.file.read(buffer, 0, maximum, resource.offset);
    resource.offset += result.bytesRead;
    return {
      eof: result.bytesRead === 0,
      bytes: LBytes.from(buffer.subarray(0, result.bytesRead)),
    };
  }

  async openWrite(
    path: string,
    options: { replace: boolean },
  ): Promise<FileResourceHandle> {
    const target = this.#lexical(path),
      parent = await realpath(dirname(target));
    if (!inside(this.root, parent)) throw new Error("PERMISSION_DENIED");
    const temporary = join(
        parent,
        `.${basename(target)}.llang-${randomUUID()}.tmp`,
      ),
      file = await open(temporary, "wx", 0o600),
      identity = await file.stat(),
      id = this.#nextId++,
      generation = 1;
    this.#resources.set(id, {
      mode: "write",
      generation,
      file,
      temporary,
      target,
      replace: options.replace,
      closed: false,
      device: identity.dev,
      inode: identity.ino,
    });
    return Object.freeze({ id, generation, mode: "write" });
  }

  async writeChunk(handle: FileResourceHandle, bytes: LBytes): Promise<number> {
    if (bytes.length > 64 * 1024) throw new Error("RESOURCE_LIMIT: chunk");
    const resource = this.#get(handle, "write") as WriteResource,
      value = bytes.toUint8Array();
    let offset = 0;
    while (offset < value.length) {
      const result = await resource.file.write(
        value,
        offset,
        value.length - offset,
      );
      offset += result.bytesWritten;
    }
    return offset;
  }

  async commit(handle: FileResourceHandle): Promise<void> {
    const resource = this.#get(handle, "write") as WriteResource;
    resource.closed = true;
    await resource.file.sync();
    await this.#assertOwnTemporary(resource);
    await resource.file.close();
    try {
      await this.#assertOwnTemporary(resource);
      if (resource.replace) await rename(resource.temporary, resource.target);
      else {
        await link(resource.temporary, resource.target);
        await this.#unlinkOwnTemporary(resource);
      }
      this.#resources.delete(handle.id);
    } catch (error) {
      await this.#unlinkOwnTemporary(resource).catch(() => undefined);
      this.#resources.delete(handle.id);
      throw error;
    }
  }

  async abort(handle: FileResourceHandle): Promise<void> {
    const resource = this.#resources.get(handle.id);
    if (!resource || resource.generation !== handle.generation) return;
    this.#resources.delete(handle.id);
    await resource.file.close().catch(() => undefined);
    if (resource.mode === "write") await this.#unlinkOwnTemporary(resource);
  }

  async close(handle: FileResourceHandle): Promise<void> {
    const resource = this.#resources.get(handle.id);
    if (!resource || resource.generation !== handle.generation) return;
    if (resource.mode === "write") return this.abort(handle);
    this.#resources.delete(handle.id);
    await resource.file.close();
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.#resources.keys()].map((id) => {
        const resource = this.#resources.get(id);
        if (!resource) return Promise.resolve();
        return this.abort({
          id,
          generation: resource.generation,
          mode: resource.mode,
        });
      }),
    );
  }

  #lexical(path: string): string {
    if (!path || isAbsolute(path)) throw new Error("PERMISSION_DENIED");
    const target = resolve(this.root, path);
    if (!inside(this.root, target)) throw new Error("PERMISSION_DENIED");
    return target;
  }

  async #existing(path: string): Promise<string> {
    const target = this.#lexical(path),
      canonical = await realpath(target);
    if (!inside(this.root, canonical)) throw new Error("PERMISSION_DENIED");
    return canonical;
  }

  #get(handle: FileResourceHandle, mode: "read" | "write"): Resource {
    const resource = this.#resources.get(handle.id);
    if (
      !resource ||
      resource.generation !== handle.generation ||
      resource.mode !== mode ||
      (resource.mode === "write" && resource.closed)
    )
      throw new Error("STALE_RESOURCE_HANDLE");
    return resource;
  }

  async #assertOwnTemporary(resource: WriteResource): Promise<void> {
    const current = await lstat(resource.temporary);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== resource.device ||
      current.ino !== resource.inode
    )
      throw new Error("PERMISSION_DENIED: temporary path changed");
  }

  async #unlinkOwnTemporary(resource: WriteResource): Promise<void> {
    await this.#assertOwnTemporary(resource);
    await unlink(resource.temporary);
  }
}
