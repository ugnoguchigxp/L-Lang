import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { evaluatePaper, parsePaperOracle } from "./paper-evaluate";
import { saveInventory } from "./paper-evidence";
import { createPaperTestRun } from "./paper-test-fixture";

test("access Oracle passes and each negative layer detects its case", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-evaluate-"));
  try {
    await createPaperTestRun(resolve(root, "source"));
    await saveInventory(
      resolve(root, "source"),
      resolve(root, "inventory"),
      "fixture",
    );
    const result = await evaluatePaper(
      resolve(root, "inventory/inventory.json"),
      resolve("research/paper-v1/access-oracle.json"),
      resolve(root, "out"),
    );
    expect(result.status).toBe("pass");
    expect(result.cases).toHaveLength(8);
    expect(result.negative.legalWrongIr.counterexamples).toContain(
      "enabled-suspended",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Oracle rejects malformed expected outcomes", () => {
  const base = {
    version: 1,
    taskId: "access",
    origin: "test",
    review: "unreviewed",
  };
  expect(() =>
    parsePaperOracle({
      ...base,
      cases: [
        { id: "case", input: {}, expected: { kind: "value", value: "true" } },
      ],
    }),
  ).toThrow("invalid oracle cases");
  expect(() =>
    parsePaperOracle({
      ...base,
      cases: [
        { id: "case", input: {}, expected: { kind: "error", code: "OTHER" } },
      ],
    }),
  ).toThrow("invalid oracle cases");
});
