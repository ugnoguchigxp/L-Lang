import { open, realpath, unlink } from "node:fs/promises";
import { WasmError } from "./wasm-contract";

/** Cooperative lock for L-Lang writers. External editors still require a snapshot check. */
export async function withSourceWriteLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = `${await realpath(path)}.llang-write.lock`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new WasmError(
        "SOURCE_CONFLICT",
        "another L-Lang writer holds the source lock",
      );
    throw error;
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(lockPath);
  }
}
