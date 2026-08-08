import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type AtomicWriteOptions = {
  mode?: number;
  syncDirectory?: boolean;
};

export async function atomicWriteFile(
  path: string,
  value: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${randomUUID()}.atomic.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
    if (options.syncDirectory ?? true) {
      await syncParentDirectory(directory);
    }
  } catch (error) {
    if (!renamed) await unlinkIfExists(temporary);
    throw error;
  }
}

export async function atomicWriteText(
  path: string,
  value: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicWriteFile(path, value, options);
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

async function syncParentDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await handle?.close();
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function directorySyncUnsupported(error: unknown): boolean {
  return hasErrorCode(error, [
    "EACCES",
    "EBADF",
    "EISDIR",
    "EINVAL",
    "ENOTSUP",
    "EPERM",
  ]);
}

function isNotFound(error: unknown): boolean {
  return hasErrorCode(error, ["ENOENT"]);
}

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    codes.includes(String(error.code))
  );
}
