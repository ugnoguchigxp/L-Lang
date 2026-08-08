import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  atomicWriteFile,
  atomicWriteJson,
  atomicWriteText,
} from "./atomic-file";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("atomic file writer", () => {
  test("writes bytes, text, and JSON through exclusive temporary files", async () => {
    const root = await temporaryRoot();
    const bytesPath = resolve(root, "nested/bytes.bin");
    const textPath = resolve(root, "text.txt");
    const jsonPath = resolve(root, "value.json");

    await atomicWriteFile(bytesPath, new Uint8Array([0xff, 0x00, 0x80]));
    await atomicWriteText(textPath, "value\n");
    await atomicWriteJson(jsonPath, { version: 1 });

    expect([...(await readFile(bytesPath))]).toEqual([0xff, 0x00, 0x80]);
    expect(await readFile(textPath, "utf8")).toBe("value\n");
    expect(await readFile(jsonPath, "utf8")).toBe('{\n  "version": 1\n}\n');
    if (process.platform !== "win32") {
      expect((await stat(textPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("removes its temporary file when rename fails", async () => {
    const root = await temporaryRoot();
    const target = resolve(root, "target");
    await mkdir(target);

    await expect(atomicWriteText(target, "value")).rejects.toThrow();
    expect(
      (await readdir(root)).filter((name) => name.includes(".atomic.tmp")),
    ).toEqual([]);
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  test("uses collision-free temporary paths for concurrent writers", async () => {
    const root = await temporaryRoot();
    const target = resolve(root, "target.txt");
    const values = Array.from({ length: 16 }, (_, index) => `value-${index}\n`);

    await Promise.all(values.map((value) => atomicWriteText(target, value)));

    expect(values).toContain(await readFile(target, "utf8"));
    expect(
      (await readdir(root)).filter((name) => name.includes(".atomic.tmp")),
    ).toEqual([]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "l-lang-atomic-file-"));
  roots.push(root);
  return root;
}
