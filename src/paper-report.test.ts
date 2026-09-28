import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { evaluatePaper } from "./paper-evaluate";
import { saveInventory } from "./paper-evidence";
import { savePaperReport } from "./paper-report";
import { reproducePaper } from "./paper-reproduce";
import { createPaperTestRun } from "./paper-test-fixture";

test("historical case table derives from saved reproduction and Oracle", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-access-report-"));
  try {
    await createPaperTestRun(resolve(root, "source"));
    await saveInventory(
      resolve(root, "source"),
      resolve(root, "inventory"),
      "fixture",
    );
    await reproducePaper(
      resolve(root, "inventory/inventory.json"),
      resolve(root, "run"),
    );
    await evaluatePaper(
      resolve(root, "inventory/inventory.json"),
      resolve("research/paper-v1/access-oracle.json"),
      resolve(root, "run/evaluation"),
    );
    const result = await savePaperReport(
      resolve(root, "run"),
      resolve(root, "report"),
    );
    expect(result.summary.oraclePass).toBe(8);
    expect("byteEqual" in result.summary && result.summary.byteEqual).toBe(
      true,
    );
    expect(await readFile(resolve(root, "report/table.md"), "utf8")).toContain(
      "Historical access case",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
