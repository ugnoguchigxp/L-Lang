import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCollectionStabilityChild } from "./llang-collection-stability-child";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { emitCollectionModuleWasm } from "./llang-module-collection-wasm";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Collection stability child", () => {
  test("honors lane order and records resource diagnostics outside traces", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-stability-child-"));
    roots.push(root);
    const program = await loadCollectionModuleProgram(
        "programs/fold.ts",
        "benchmarks/collection-binaryen-v1",
        "evaluate",
      ),
      emitted = emitCollectionModuleWasm(program),
      input = { values: [1, 2, 3] },
      expected = evaluateCollectionProgram(program, input),
      files = [
        "input.wasm",
        "contract.json",
        "input.json",
        "expected.json",
        "request.json",
        "output.json",
      ].map((name) => join(root, name));
    await Promise.all([
      writeFile(files[0] as string, emitted.bytes),
      writeFile(files[1] as string, JSON.stringify(emitted.contract)),
      writeFile(files[2] as string, JSON.stringify(input)),
      writeFile(files[3] as string, JSON.stringify({ value: expected })),
      writeFile(
        files[4] as string,
        JSON.stringify({
          warmup: 1,
          samples: 2,
          laneOrder: ["module-cached", "cold"],
        }),
      ),
    ]);
    await runCollectionStabilityChild(
      ...(files as [string, string, string, string, string, string]),
    );
    const result = JSON.parse(await readFile(files[5] as string, "utf8"));
    expect(result.laneOrder).toEqual(["module-cached", "cold"]);
    expect(result.lanes.cold).toHaveLength(2);
    expect(result.lanes["module-cached"]).toHaveLength(2);
    expect(
      result.lanes["module-cached"].every(
        (row: { compileNs: number }) => row.compileNs === 0,
      ),
    ).toBe(true);
    expect(result.resources.startRssBytes).toBeGreaterThan(0);
    for (const row of [...result.lanes.cold, ...result.lanes["module-cached"]])
      expect(row.totalNs).toBe(row.accountedNs + row.unattributedNs);
  });
});
