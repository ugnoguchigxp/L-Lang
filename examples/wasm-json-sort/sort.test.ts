import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, hash, parseProgram, optimizations } from "./compiler";
import {
  decode,
  encode,
  generateJson,
  MAX_RECORDS,
  parseRows,
  reference,
} from "./data";
import { createWasm } from "./runtime";
import { run } from "./run";

const source = await readFile(join(import.meta.dir, "sort.jsonc"), "utf8");

test("deterministic ~100KiB fixture and invalid data rejection", () => {
  const json = generateJson();
  expect(json).toBe(generateJson());
  expect(Buffer.byteLength(json)).toBeGreaterThanOrEqual(102400);
  expect(Buffer.byteLength(json)).toBeLessThan(102700);
  expect(parseRows(json).length).toBeGreaterThan(400);
  expect(() => parseRows("{}")).toThrow();
  expect(() => parseRows('[{"id":0}]')).toThrow();
  const row = parseRows(json)[0];
  if (!row) throw new Error("Empty fixture");
  expect(() => parseRows(JSON.stringify([row, row]))).toThrow();
  expect(() => parseRows(JSON.stringify([{ ...row, age: 1.5 }]))).toThrow();
  expect(() => parseRows(JSON.stringify([{ ...row, name: null }]))).toThrow();
  expect(() =>
    parseRows(JSON.stringify(Array(MAX_RECORDS + 1).fill(row))),
  ).toThrow();
});

test("experimental program rejects unsupported keys, algorithms, duplicates and profiles", () => {
  expect(parseProgram(source).jobs).toHaveLength(15);
  expect(() => parseProgram(source.replace('"age"', '"height"'))).toThrow();
  expect(() => parseProgram(source.replace('"heap"', '"bogus"'))).toThrow();
  expect(() =>
    parseProgram(source.replace('"selection"', '"insertion"')),
  ).toThrow();
  expect(() =>
    parseProgram(source.replace("json-sort-i32-v1", "predicate-i32-v1")),
  ).toThrow();
  expect(() => parseProgram("{")).toThrow();
  expect(() =>
    parseProgram(source.replace('"version": 1', '"version": 1, "version": 1')),
  ).toThrow();
});

for (const optimization of optimizations) {
  test(`generated TS/Wasm agree with independent oracle; optimization=${optimization}`, async () => {
    const output = await mkdtemp(join(tmpdir(), "llang-sort-"));
    try {
      const built = await compile(source, output, { optimization });
      const second = await compile(source, join(output, "again"), {
        optimization,
      });
      expect(built.manifest.optimizationLevel).toBe(
        optimization === "none" ? 0 : optimization === "O3" ? 3 : 2,
      );
      expect(built.manifest.shrinkLevel).toBe(
        optimization === "legacy" ? 1 : 0,
      );
      expect(second.manifest.wasmHash).toBe(built.manifest.wasmHash);
      expect(second.manifest.typescriptHash).toBe(
        built.manifest.typescriptHash,
      );
      const generated = await import(
        pathToFileURL(join(output, "sort.generated.ts")).href
      );
      const base = parseRows(generateJson());
      const first = base[0];
      if (!first) throw new Error("Empty fixture");
      const ties = base.slice(0, 30).map((row, index) => ({
        ...row,
        id: 1000 - index,
        name: "同名",
        age: 42,
        race: "elf",
      }));
      const wasm = await createWasm(built.bytes, MAX_RECORDS);
      // Random, empty, singleton, all tied, presorted, reversed and duplicate-heavy.
      for (const job of built.manifest.program.jobs) {
        const literalRows = [
          { ...first, id: 50, name: "😀", age: 2, race: "orc" },
          { ...first, id: 40, name: "A", age: 10, race: "elf" },
          { ...first, id: 30, name: "É", age: 2, race: "elf" },
          { ...first, id: 20, name: "A", age: 0, race: "human" },
          { ...first, id: 10, name: "光", age: 10, race: "dwarf" },
        ];
        const literalIds = {
          name: [40, 20, 30, 10, 50],
          age: [20, 50, 30, 40, 10],
          race: [10, 40, 30, 20, 50],
        };
        const literalEncoded = encode(literalRows, job.key);
        const literalTs = new Int32Array(literalEncoded);
        generated[job.exportName](literalTs);
        wasm.load(literalEncoded);
        wasm.sort(job.exportName, literalRows.length);
        expect(decode(literalRows, literalTs).map((row) => row.id)).toEqual(
          literalIds[job.key],
        );
        expect(
          decode(literalRows, wasm.view(literalRows.length)).map(
            (row) => row.id,
          ),
        ).toEqual(literalIds[job.key]);
        const sorted = reference(base, job.key);
        const cases = [
          base,
          [],
          base.slice(0, 1),
          ties,
          sorted,
          [...sorted].reverse(),
          base.slice(0, 50).map((row, index) => ({ ...row, age: index % 3 })),
        ];
        for (const rows of cases) {
          const expected = reference(rows, job.key);
          const encoded = encode(rows, job.key);
          const tsData = new Int32Array(encoded);
          generated[job.exportName](tsData);
          wasm.load(encoded);
          wasm.sort(job.exportName, rows.length);
          expect(decode(rows, tsData)).toEqual(expected);
          expect(decode(rows, wasm.view(rows.length))).toEqual(expected);
        }
      }
      // Exercise >1 Wasm memory page and the maximum rank/index encoding.
      const many = Array.from({ length: MAX_RECORDS }, (_, i) => ({
        ...first,
        id: i,
        age: MAX_RECORDS - i,
      }));
      const encoded = encode(many, "age");
      const expected = reference(many, "age");
      generated.sort_age_heap(encoded);
      expect(decode(many, encoded)).toEqual(expected);
      wasm.load(encode(many, "age"));
      wasm.sort("sort_age_heap", many.length);
      expect(decode(many, wasm.view(many.length))).toEqual(expected);
      expect(() => wasm.sort("sort_age_heap", MAX_RECORDS + 1)).toThrow();
      expect(() => wasm.load(new Int32Array(MAX_RECORDS + 1))).toThrow();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }, 30000);
}

test("runner persists generated files, matching outputs and raw timings", async () => {
  const root = await mkdtemp(join(tmpdir(), "llang-sort-report-"));
  try {
    const output = join(root, "run");
    const report = await run([
      "--optimization",
      "O3",
      "--bytes",
      "1000",
      "--samples",
      "3",
      "--warmup",
      "1",
      "--iterations",
      "1",
      "--key",
      "age",
      "--algorithm",
      "heap",
      "--out",
      output,
    ]);
    expect(report.manifest.optimization).toBe("O3");
    expect(report.manifest.shrinkLevel).toBe(0);
    const result = report.results[0];
    if (!result) throw new Error("No results");
    const ts = await readFile(join(output, "sort_age_heap.typescript.json"));
    const wasm = await readFile(join(output, "sort_age_heap.wasm.json"));
    expect(hash(ts)).toBe(result.typescriptResultHash);
    expect(hash(wasm)).toBe(result.wasmResultHash);
    expect(result.typescriptResultHash).toBe(result.oracleHash);
    expect(ts).toEqual(wasm);
    expect(result.kernel.wasm.samplesMs).toHaveLength(3);
    expect(result.endToEnd.typescript.samplesMs).toHaveLength(3);
    expect(
      JSON.parse(await readFile(join(output, "report.json"), "utf8")),
    ).toEqual(report);
    expect(hash(await readFile(join(output, "sort.generated.ts")))).toBe(
      report.manifest.typescriptHash,
    );
    expect(hash(await readFile(join(output, "sort.wasm")))).toBe(
      report.manifest.wasmHash,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("build presets restore Binaryen globals and reproduce legacy output", async () => {
  const { default: binaryen } = await import("binaryen");
  const previousOptimize = binaryen.getOptimizeLevel();
  const previousShrink = binaryen.getShrinkLevel();
  const output = await mkdtemp(join(tmpdir(), "llang-opt-globals-"));
  try {
    binaryen.setOptimizeLevel(1);
    binaryen.setShrinkLevel(2);
    const legacy = await compile(source, join(output, "legacy"));
    const earlier = JSON.parse(
      await readFile(join(import.meta.dir, "evidence/forward.json"), "utf8"),
    );
    expect(legacy.manifest.wasmHash).toBe(earlier.manifest.wasmHash);
    expect(legacy.manifest.typescriptHash).toBe(
      earlier.manifest.typescriptHash,
    );
    await compile(source, join(output, "O3"), { optimization: "O3" });
    expect(binaryen.getOptimizeLevel()).toBe(1);
    expect(binaryen.getShrinkLevel()).toBe(2);
    const none = await compile(
      source.replace('"optimize": true', '"optimize": false'),
      join(output, "none"),
    );
    expect(none.manifest.optimizationPassApplied).toBe(false);
    expect(none.optimizationMs).toBe(0);
  } finally {
    binaryen.setOptimizeLevel(previousOptimize);
    binaryen.setShrinkLevel(previousShrink);
    await rm(output, { recursive: true, force: true });
  }
});

for (const optimization of ["O2", "O3"] as const) {
  test(`selection branch experiment preserves outputs at ${optimization}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-selection-branch-"));
    try {
      const { analyzeSelection, restoreSelectionBranch } = await import(
        "./selection-analysis"
      );
      const baseline = await compile(source, join(root, "baseline"), {
        optimization,
      });
      const branch = await compile(source, join(root, "branch"), {
        optimization,
        selectionBranch: true,
      });
      expect(branch.manifest.typescriptHash).toBe(
        baseline.manifest.typescriptHash,
      );
      const baseWat = await readFile(
        join(root, "baseline/sort.generated.wat"),
        "utf8",
      );
      const branchWat = await readFile(
        join(root, "branch/sort.generated.wat"),
        "utf8",
      );
      expect(analyzeSelection(baseWat, "sort_age_selection").select).toBe(1);
      expect(analyzeSelection(branchWat, "sort_age_selection").select).toBe(0);
      expect(() =>
        restoreSelectionBranch(branchWat, "sort_age_selection"),
      ).toThrow();
      const rows = parseRows(generateJson());
      const wasm = await createWasm(branch.bytes, rows.length);
      for (const job of branch.manifest.program.jobs) {
        const ordered = reference(rows, job.key);
        for (const input of [
          rows,
          [],
          rows.slice(0, 1),
          ordered,
          [...ordered].reverse(),
          rows
            .slice(0, 30)
            .map((r) => ({ ...r, name: "same", age: 1, race: "elf" })),
        ]) {
          wasm.load(encode(input, job.key));
          wasm.sort(job.exportName, input.length);
          expect(decode(input, wasm.view(input.length))).toEqual(
            reference(input, job.key),
          );
        }
      }
      // Signed i32 extremes exercise the rewrite beyond the rank encoder's domain.
      const integers = new Int32Array([2147483647, -2147483648, 0, 1, -1, 1]);
      wasm.load(integers);
      wasm.sort("sort_age_selection", integers.length);
      expect([...wasm.view(integers.length)]).toEqual([
        -2147483648, -1, 0, 1, 1, 2147483647,
      ]);
      await expect(
        compile(source, join(root, "invalid"), {
          optimization: "none",
          selectionBranch: true,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
}

test("record-count datasets preserve the seed and previous 710-record fixture", async () => {
  const fixture = await readFile(join(import.meta.dir, "data.json"), "utf8");
  expect(generateJson(102400, 710)).toBe(fixture);
  const large = parseRows(generateJson(102400, 3550));
  expect(large).toHaveLength(3550);
  expect(large.slice(0, 710)).toEqual(parseRows(fixture));
  expect(() => generateJson(102400, 0)).toThrow();
  expect(() => generateJson(102400, MAX_RECORDS + 1)).toThrow();
  await expect(
    run(["--records", "710", "--bytes", "102400"]),
  ).rejects.toThrow();
});
