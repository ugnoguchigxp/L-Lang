import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import {
  COLLECTION_COST_CANDIDATE_SHARE,
  deterministicCollectionCost,
  measureCollectionCost,
} from "./llang-collection-cost";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { emitCollectionModuleWasm } from "./llang-module-collection-wasm";
import {
  renderCollectionMemorySafetyMatrix,
  type CollectionMemorySafetyMatrix,
} from "./llang-collection-memory-matrix";

describe("collection cost observation", () => {
  test("counters are deterministic and absent from product artifacts", async () => {
    const program = await loadCollectionModuleProgram(
        "application/evaluate.llang.jsonc",
        "examples/module-order-batch",
        "evaluate",
      ),
      input = { values: [5, 1, 3, 2], threshold: 2 },
      first = measureCollectionCost(program, input),
      second = measureCollectionCost(program, input),
      product = emitCollectionModuleWasm(program),
      exports = WebAssembly.Module.exports(
        new WebAssembly.Module(product.bytes as BufferSource),
      ).map((item) => item.name);
    expect(deterministicCollectionCost(second)).toEqual(
      deterministicCollectionCost(first),
    );
    expect(exports).toEqual(["memory", "evaluate", "fault_code"]);
    expect(first.metrics.allocationCalls).toBeGreaterThan(0);
    expect(first.metrics.copyBytes).toBeGreaterThan(0);
    expect(first.metrics.validationListElements).toBe(input.values.length);
    expect(first.output).toEqual({ values: [2, 3, 5], total: 10 });
    expect(deterministicCollectionCost(first)).toEqual(
      JSON.parse(
        await readFile(
          "benchmarks/collection-memory-v1/expected/cost.json",
          "utf8",
        ),
      ),
    );
  });

  test("checked-in cost and safety artifacts satisfy their schemas", async () => {
    const load = async (path: string) =>
        JSON.parse(await readFile(path, "utf8")),
      ajv = new Ajv2020({ strict: true }),
      costSchema = await load(
        "schemas/collection-cost-observation-v1.schema.json",
      ),
      matrixSchema = await load(
        "schemas/collection-memory-safety-matrix-v1.schema.json",
      ),
      cost = await load("benchmarks/collection-memory-v1/expected/cost.json"),
      matrix = await load(
        "benchmarks/collection-memory-v1/memory-safety-matrix.json",
      ),
      freeze = await load("benchmarks/collection-memory-v1/freeze.json"),
      program = await loadCollectionModuleProgram(
        "application/evaluate.llang.jsonc",
        "examples/module-order-batch",
        "evaluate",
      ),
      measured = measureCollectionCost(program, {
        values: [5, 1, 3, 2],
        threshold: 2,
      }),
      validateCost = ajv.compile(costSchema);
    expect(validateCost(cost)).toBe(true);
    expect(validateCost(measured)).toBe(true);
    expect(freeze.thresholds.candidateShare).toBe(
      COLLECTION_COST_CANDIDATE_SHARE,
    );
    expect(ajv.compile(matrixSchema)(matrix)).toBe(true);
    expect(
      new Set(matrix.entries.map((entry: { id: string }) => entry.id)).size,
    ).toBe(matrix.entries.length);
    expect(
      await readFile("docs/COLLECTION_MEMORY_SAFETY_MATRIX.md", "utf8"),
    ).toBe(
      renderCollectionMemorySafetyMatrix(
        matrix as CollectionMemorySafetyMatrix,
      ),
    );
  });

  test("cost CLI rejects unknown flags and configuration keys", async () => {
    const unknownFlag = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        "src/llang-collection-cost-cli.ts",
        "missing.json",
        "/tmp/missing.json",
        "--unknown",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unknownFlag.exitCode).not.toBe(0);

    const root = await mkdtemp(join(tmpdir(), "llang-collection-cost-cli-"));
    try {
      const configuration = JSON.parse(
        await readFile(
          "benchmarks/collection-memory-v1/benchmark.json",
          "utf8",
        ),
      );
      configuration.extra = true;
      const input = join(root, "benchmark.json");
      await writeFile(input, JSON.stringify(configuration));
      const extraKey = Bun.spawnSync({
        cmd: [
          process.execPath,
          "run",
          "src/llang-collection-cost-cli.ts",
          input,
          join(root, "output.json"),
          "--deterministic",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(extraKey.exitCode).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
