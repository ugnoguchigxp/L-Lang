import { afterEach, expect, test } from "bun:test";
import {
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  inspectEvidence,
  saveInventory,
  verifyInventory,
} from "./paper-evidence";
import { createPaperTestRun } from "./paper-test-fixture";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function sandbox() {
  const root = await mkdtemp(resolve(tmpdir(), "paper-evidence-"));
  roots.push(root);
  return root;
}

test("inventory verifies linked evidence after relocation and refuses reuse", async () => {
  const root = await sandbox();
  const source = resolve(root, "source");
  await createPaperTestRun(source);
  expect((await inspectEvidence(source, "past-live")).diagnostics).toContain(
    "origin differs from recorded run mode",
  );
  const result = await saveInventory(source, resolve(root, "saved"), "fixture");
  expect(result.inventory.diagnostics).toEqual([]);
  await rename(resolve(root, "saved"), resolve(root, "moved"));
  expect(
    (await verifyInventory(resolve(root, "moved/inventory.json"))).wasmHash,
  ).toBe(result.inventory.wasmHash);
  await expect(saveInventory(source, resolve(root, "moved"))).rejects.toThrow();
  await expect(
    saveInventory(source, resolve(source, "inside")),
  ).rejects.toThrow();
  expect(result.environment.original.commit).toBe("unknown");
  expect(result.environment.observed.bunLockSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.environment.observed.backend).toBe("binaryen@132.0.0");
});

test("inventory rejects an output nested in input through a parent symlink", async () => {
  const root = await sandbox();
  const source = resolve(root, "source");
  await createPaperTestRun(source);
  await symlink(source, resolve(root, "alias"), "dir");
  await expect(
    saveInventory(source, resolve(root, "alias", "nested"), "fixture"),
  ).rejects.toThrow("output must be outside input root");
  await expect(
    saveInventory(source, resolve(root, "alias", "new", "nested"), "fixture"),
  ).rejects.toThrow("output must be outside input root");
  expect(
    await Bun.file(resolve(source, "nested", "inventory.json")).exists(),
  ).toBe(false);
  expect(await Bun.file(resolve(source, "new")).exists()).toBe(false);
});

test("missing, byte change and related hash mismatch are detected", async () => {
  const root = await sandbox();
  const source = resolve(root, "source");
  await createPaperTestRun(source);
  const copy = resolve(root, "input");
  await cp(source, copy, { recursive: true });
  expect((await inspectEvidence(copy, "fixture")).diagnostics).toEqual([]);
  const path = resolve(copy, "source.json");
  const sourceData = JSON.parse(await readFile(path, "utf8"));
  sourceData.intent += " changed";
  await writeFile(path, JSON.stringify(sourceData));
  expect(
    (await inspectEvidence(copy, "fixture")).diagnostics.some((d) =>
      d.includes("related hash mismatch"),
    ),
  ).toBe(true);
  await saveInventory(copy, resolve(root, "saved"), "fixture");
  const copied = resolve(root, "saved/evidence/source.json");
  await writeFile(
    copied,
    Buffer.concat([await readFile(copied), Buffer.from(" ")]),
  );
  await expect(
    verifyInventory(resolve(root, "saved/inventory.json")),
  ).rejects.toThrow("hash mismatch");
  await rm(resolve(copy, "tests.json"));
  expect((await inspectEvidence(copy, "fixture")).diagnostics).toContain(
    "missing tests.json",
  );
  await writeFile(resolve(copy, "private-note.txt"), "must not be copied");
  const output = await saveInventory(
    copy,
    resolve(root, "selected"),
    "fixture",
  );
  expect(output.inventory.diagnostics).toContain(
    "unselected file: private-note.txt",
  );
  expect(
    await Bun.file(
      resolve(root, "selected/evidence/private-note.txt"),
    ).exists(),
  ).toBe(false);
});
