import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export async function readStableRegularFileSnapshot(
  path: string,
  maximumBytes: number,
  invalidCode: string,
): Promise<Readonly<{ bytes: Uint8Array; dev: number; ino: number }>> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumBytes)
      throw new Error(invalidCode);
    const bytes = await handle.readFile(),
      after = await handle.stat(),
      current = await lstat(path);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      bytes.length !== before.size ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size
    )
      throw new Error(invalidCode);
    return Object.freeze({ bytes, dev: before.dev, ino: before.ino });
  } catch (error) {
    if (error instanceof Error && error.message === invalidCode) throw error;
    throw new Error(invalidCode, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readStableRegularFile(
  path: string,
  maximumBytes: number,
  invalidCode: string,
): Promise<Uint8Array> {
  return (await readStableRegularFileSnapshot(path, maximumBytes, invalidCode))
    .bytes;
}
