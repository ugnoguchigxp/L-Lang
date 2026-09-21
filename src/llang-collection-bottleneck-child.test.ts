import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCollectionBottleneckChild } from "./llang-collection-bottleneck-child";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { emitCollectionModuleWasm } from "./llang-module-collection-wasm";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Collection bottleneck child", () => {
  test("records additive cold and cached traces", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-bottleneck-child-"));
    roots.push(root);
    const program = await loadCollectionModuleProgram(
        "programs/fold.ts",
        "benchmarks/collection-binaryen-v1",
        "evaluate",
      ),
      emitted = emitCollectionModuleWasm(program),
      input = { values: [1, 2, 3] },
      expected = evaluateCollectionProgram(program, input),
      paths = [
        "input.wasm",
        "contract.json",
        "input.json",
        "expected.json",
        "request.json",
        "output.json",
      ].map((name) => join(root, name));
    await Promise.all([
      writeFile(paths[0] as string, emitted.bytes),
      writeFile(paths[1] as string, JSON.stringify(emitted.contract)),
      writeFile(paths[2] as string, JSON.stringify(input)),
      writeFile(paths[3] as string, JSON.stringify({ value: expected })),
      writeFile(paths[4] as string, JSON.stringify({ warmup: 0, samples: 2 })),
    ]);
    await runCollectionBottleneckChild(
      paths[0] as string,
      paths[1] as string,
      paths[2] as string,
      paths[3] as string,
      paths[4] as string,
      paths[5] as string,
    );
    const result = JSON.parse(await readFile(paths[5] as string, "utf8"));
    expect(result.cold).toHaveLength(2);
    expect(result.cached).toHaveLength(2);
    for (const row of [...result.cold, ...result.cached]) {
      expect(row.totalNs).toBe(row.accountedNs + row.unattributedNs);
      expect(row.inputBytes).toBeGreaterThan(0);
      expect(row.outputBytes).toBeGreaterThan(0);
    }
    expect(
      result.cached.every((row: { compileNs: number }) => row.compileNs === 0),
    ).toBe(true);
    await writeFile(
      paths[3] as string,
      JSON.stringify({ value: { wrong: true } }),
    );
    await expect(
      runCollectionBottleneckChild(
        paths[0] as string,
        paths[1] as string,
        paths[2] as string,
        paths[3] as string,
        paths[4] as string,
        join(root, "mismatch.json"),
      ),
    ).rejects.toThrow("output mismatch");
  });

  test("rejects duplicate request keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-bottleneck-child-"));
    roots.push(root);
    const paths = [
      "input.wasm",
      "contract.json",
      "input.json",
      "expected.json",
      "request.json",
    ].map((name) => join(root, name));
    await Promise.all([
      writeFile(paths[0] as string, new Uint8Array()),
      writeFile(paths[1] as string, "{}"),
      writeFile(paths[2] as string, "{}"),
      writeFile(paths[3] as string, '{"value":{}}'),
      writeFile(paths[4] as string, '{"warmup":0,"samples":1,"samples":2}'),
    ]);
    await expect(
      runCollectionBottleneckChild(
        paths[0] as string,
        paths[1] as string,
        paths[2] as string,
        paths[3] as string,
        paths[4] as string,
        join(root, "output.json"),
      ),
    ).rejects.toThrow('LLJ002 /samples: duplicate key "samples"');
  });

  test("rejects a symbolic-link input before parsing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-bottleneck-child-"));
    roots.push(root);
    const wasm = join(root, "input.wasm"),
      contractTarget = join(root, "contract-target.json"),
      contract = join(root, "contract.json"),
      input = join(root, "input.json"),
      expected = join(root, "expected.json"),
      request = join(root, "request.json");
    await Promise.all([
      writeFile(wasm, new Uint8Array()),
      writeFile(contractTarget, "{}"),
      writeFile(input, "{}"),
      writeFile(expected, '{"value":{}}'),
      writeFile(request, '{"warmup":0,"samples":1}'),
    ]);
    await symlink(contractTarget, contract);
    await expect(
      runCollectionBottleneckChild(
        wasm,
        contract,
        input,
        expected,
        request,
        join(root, "output.json"),
      ),
    ).rejects.toThrow("invalid input or output");
  });
});
