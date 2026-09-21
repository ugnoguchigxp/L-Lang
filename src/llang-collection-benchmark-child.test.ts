import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCollectionBenchmarkChild } from "./llang-collection-benchmark-child";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { emitUnoptimizedCollectionModuleWasm } from "./llang-module-collection-wasm";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("isolated Collection benchmark child", () => {
  test("records bounded raw timings and peak RSS", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-benchmark-child-test-"));
    roots.push(root);
    const program = await loadCollectionModuleProgram(
        "application/evaluate.llang.jsonc",
        "examples/module-order-batch",
        "evaluate",
      ),
      emitted = emitUnoptimizedCollectionModuleWasm(program),
      wasm = join(root, "input.wasm"),
      contract = join(root, "contract.json"),
      input = join(root, "input.json"),
      request = join(root, "request.json"),
      output = join(root, "output.json");
    await Promise.all([
      writeFile(wasm, emitted.bytes),
      writeFile(contract, JSON.stringify(emitted.contract)),
      writeFile(
        input,
        JSON.stringify({ values: [5, 1, 3, 2, 3], threshold: 2 }),
      ),
      writeFile(
        request,
        JSON.stringify({ warmup: 0, iterations: 1, samples: 2 }),
      ),
    ]);

    await runCollectionBenchmarkChild(wasm, contract, input, request, output);
    const result = JSON.parse(await readFile(output, "utf8"));
    expect(result.timings).toHaveLength(2);
    expect(result.timings.map((row: { sample: number }) => row.sample)).toEqual(
      [0, 1],
    );
    for (const row of result.timings)
      for (const key of [
        "compileMs",
        "instantiateMs",
        "evaluateMs",
        "endToEndMs",
      ])
        expect(row[key]).toBeGreaterThanOrEqual(0);
    expect(result.peakRssBytes).toBeGreaterThan(0);
  });

  test("rejects an unbounded request before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-benchmark-child-test-"));
    roots.push(root);
    const paths = [
      "input.wasm",
      "contract.json",
      "input.json",
      "request.json",
    ].map((name) => join(root, name));
    await Promise.all([
      writeFile(paths[0] as string, new Uint8Array()),
      writeFile(paths[1] as string, "{}"),
      writeFile(paths[2] as string, "{}"),
      writeFile(
        paths[3] as string,
        JSON.stringify({ warmup: 0, iterations: 1, samples: 101 }),
      ),
    ]);
    await expect(
      runCollectionBenchmarkChild(
        paths[0] as string,
        paths[1] as string,
        paths[2] as string,
        paths[3] as string,
        join(root, "output.json"),
      ),
    ).rejects.toThrow("invalid request");
  });

  test("rejects duplicate JSON keys before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-benchmark-child-test-"));
    roots.push(root);
    const paths = [
      "input.wasm",
      "contract.json",
      "input.json",
      "request.json",
    ].map((name) => join(root, name));
    await Promise.all([
      writeFile(paths[0] as string, new Uint8Array()),
      writeFile(paths[1] as string, "{}"),
      writeFile(paths[2] as string, "{}"),
      writeFile(
        paths[3] as string,
        '{"warmup":0,"iterations":1,"samples":1,"samples":2}',
      ),
    ]);
    await expect(
      runCollectionBenchmarkChild(
        paths[0] as string,
        paths[1] as string,
        paths[2] as string,
        paths[3] as string,
        join(root, "output.json"),
      ),
    ).rejects.toThrow('LLJ002 /samples: duplicate key "samples"');
  });
});
