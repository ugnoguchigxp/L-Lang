import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Decimal } from "../../src/llang-effects-values";
import { LocalFileAdapter } from "../../src/llang-io-file-adapter";
import { runModuleIoPipeline } from "../../src/llang-module-io-pipeline";

describe("module IO pipeline vertical example", () => {
  test("streams typed orders, enriches concurrently, computes decimal and commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-pipeline-"));
    try {
      await writeFile(
        join(root, "orders.ndjson"),
        [
          { id: "A", quantity: "2", unit: { coefficient: "125", scale: 2 } },
          { id: "B", quantity: "3", unit: { coefficient: "200", scale: 2 } },
        ]
          .map((value) => JSON.stringify(value))
          .join("\n"),
      );
      const adapter = await LocalFileAdapter.create(root),
        result = await runModuleIoPipeline({
          adapter,
          input: "orders.ndjson",
          output: "result.ndjson",
          outputScale: 2,
          enrich: async (id) => new Decimal(id === "A" ? 10n : 20n, 2),
        });
      expect(result.processed).toBe(2);
      expect(
        (await readFile(join(root, "result.ndjson"), "utf8"))
          .trim()
          .split("\n")
          .map((value) => JSON.parse(value)),
      ).toEqual([
        { id: "A", quantity: "2", total: { coefficient: "260", scale: 2 } },
        { id: "B", quantity: "3", total: { coefficient: "620", scale: 2 } },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("invalid input aborts without publishing a partial output", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-pipeline-fail-"));
    try {
      await writeFile(join(root, "orders.ndjson"), '{"id":"A"}\n');
      const adapter = await LocalFileAdapter.create(root);
      expect(
        runModuleIoPipeline({
          adapter,
          input: "orders.ndjson",
          output: "result.ndjson",
          outputScale: 2,
          enrich: async () => new Decimal(0n, 2),
        }),
      ).rejects.toThrow("INVALID_ORDER");
      expect(readFile(join(root, "result.ndjson"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
