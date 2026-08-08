import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  containedRelativePath,
  resolveContainedFile,
} from "./contained-path";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("contained file paths", () => {
  test("returns the canonical path of a regular file inside the root", async () => {
    const root = await temporaryRoot();
    const directory = resolve(root, "nested");
    const file = resolve(directory, "input.json");
    await mkdir(directory);
    await writeFile(file, "{}\n", "utf8");

    await expect(
      resolveContainedFile(root, "nested/input.json", "fixture"),
    ).resolves.toBe(await realpath(file));
    await expect(resolveContainedFile(root, file, "fixture")).resolves.toBe(
      await realpath(file),
    );
  });

  test("rejects lexical and symbolic-link escapes", async () => {
    const root = await temporaryRoot();
    const outsideRoot = await temporaryRoot();
    const outside = resolve(outsideRoot, "outside.json");
    await writeFile(outside, "{}\n", "utf8");
    await symlink(outside, resolve(root, "escape.json"));

    await expect(
      resolveContainedFile(root, outside, "fixture"),
    ).rejects.toThrow("fixture must resolve inside the workspace root");
    await expect(
      resolveContainedFile(root, "escape.json", "fixture"),
    ).rejects.toThrow("fixture must resolve inside the workspace root");
  });

  test("can reject symbolic links that remain inside the root", async () => {
    const root = await temporaryRoot();
    const target = resolve(root, "target.json");
    const link = resolve(root, "link.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, link);

    await expect(resolveContainedFile(root, link, "fixture")).resolves.toBe(
      await realpath(target),
    );
    await expect(
      resolveContainedFile(root, link, "fixture", {
        rejectSymbolicLinks: true,
      }),
    ).rejects.toThrow("fixture must not use a symbolic link");
  });

  test("rejects a directory and reports normalized relative paths", async () => {
    const root = await temporaryRoot();
    const directory = resolve(root, "nested");
    await mkdir(directory);

    await expect(
      resolveContainedFile(root, directory, "fixture"),
    ).rejects.toThrow("fixture must be a regular file");
    expect(containedRelativePath(root, directory, "fixture")).toBe("nested");
    expect(() => containedRelativePath(root, resolve(root, "../outside"), "fixture"))
      .toThrow("fixture must resolve inside the workspace root");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "l-lang-contained-path-"));
  roots.push(root);
  return root;
}
