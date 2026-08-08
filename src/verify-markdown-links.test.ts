import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { verifyMarkdownLinks } from "./verify-markdown-links";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

test("accepts local, anchored, reference, and external Markdown links", async () => {
  const root = await temporaryRoot();
  await mkdir(resolve(root, "docs"));
  await writeFile(resolve(root, "docs/target.md"), "# Target\n", "utf8");
  await writeFile(
    resolve(root, "README.md"),
    [
      "[local](./docs/target.md#target)",
      "[anchor](#section)",
      "[external](https://example.com)",
      "[reference][target]",
      "[target]: <./docs/target.md>",
    ].join("\n"),
    "utf8",
  );

  await expect(verifyMarkdownLinks(root)).resolves.toBeUndefined();
});

test("reports missing local Markdown link targets", async () => {
  const root = await temporaryRoot();
  await writeFile(rootFile(root), "[missing](./missing.md)\n", "utf8");

  await expect(verifyMarkdownLinks(root)).rejects.toThrow(
    "missing link target ./missing.md",
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "markdown-links-"));
  temporaryRoots.push(root);
  return root;
}

function rootFile(root: string): string {
  return resolve(root, "README.md");
}
