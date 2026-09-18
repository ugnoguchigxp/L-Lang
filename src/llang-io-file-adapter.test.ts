import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LBytes } from "./llang-effects-values";
import { LocalFileAdapter } from "./llang-io-file-adapter";

describe("local file effects adapter", () => {
  test("reads by handle, atomically commits, and aborts temporary writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-file-"));
    try {
      await writeFile(join(root, "input.bin"), Uint8Array.of(1, 2, 3));
      const adapter = await LocalFileAdapter.create(root),
        input = await adapter.openRead("input.bin");
      expect(await adapter.readChunk(input, 2)).toEqual({
        eof: false,
        bytes: LBytes.from([1, 2]),
      });
      expect(await adapter.readChunk(input, 2)).toEqual({
        eof: false,
        bytes: LBytes.from([3]),
      });
      expect((await adapter.readChunk(input, 2)).eof).toBe(true);
      await adapter.close(input);

      const output = await adapter.openWrite("output.bin", { replace: false });
      await adapter.writeChunk(output, LBytes.from([4, 5]));
      await adapter.commit(output);
      expect([
        ...new Uint8Array(await readFile(join(root, "output.bin"))),
      ]).toEqual([4, 5]);
      const aborted = await adapter.openWrite("aborted.bin", {
        replace: false,
      });
      await adapter.writeChunk(aborted, LBytes.from([9]));
      await adapter.abort(aborted);
      expect(readFile(join(root, "aborted.bin"))).rejects.toThrow();
      await adapter.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects traversal, symlink escape, stale handles and implicit replace", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-file-")),
      outside = await mkdtemp(join(tmpdir(), "llang-outside-"));
    try {
      await writeFile(join(root, "existing"), "old");
      await writeFile(join(outside, "secret"), "secret");
      await symlink(join(outside, "secret"), join(root, "escape"));
      const adapter = await LocalFileAdapter.create(root);
      expect(adapter.openRead("../secret")).rejects.toThrow(
        "PERMISSION_DENIED",
      );
      expect(adapter.openRead("escape")).rejects.toThrow("PERMISSION_DENIED");
      const write = await adapter.openWrite("existing", { replace: false });
      await adapter.writeChunk(write, LBytes.encodeUtf8("new"));
      expect(adapter.commit(write)).rejects.toThrow();
      expect(await readFile(join(root, "existing"), "utf8")).toBe("old");
      expect(() => adapter.writeChunk(write, LBytes.from([]))).toThrow(
        "STALE_RESOURCE_HANDLE",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("never unlinks a temporary path whose identity was replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-file-"));
    try {
      const adapter = await LocalFileAdapter.create(root),
        write = await adapter.openWrite("safe.bin", { replace: false }),
        temporary = (await readdir(root)).find((name) =>
          name.startsWith(".safe.bin.llang-"),
        );
      expect(temporary).toBeDefined();
      const path = join(root, temporary as string);
      await unlink(path);
      await writeFile(path, "attacker-owned");
      await expect(adapter.abort(write)).rejects.toThrow(
        "PERMISSION_DENIED: temporary path changed",
      );
      expect(await readFile(path, "utf8")).toBe("attacker-owned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
