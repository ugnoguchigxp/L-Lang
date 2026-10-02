import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluate } from "../examples/typescript-wasm-core/program";
import { buildCollectionModuleProgram } from "./llang-module-collection-build";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import {
  loadCollectionModuleProgram,
  parseCollectionModuleTypeScript,
} from "./llang-module-collection-loader";
import { instantiateCollectionModule } from "./llang-module-collection-runtime";
import { testCollectionModuleProgram } from "./llang-module-collection-suite";
import { emitCollectionModuleWasm } from "./llang-module-collection-wasm";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function compile(text: string) {
  const root = await mkdtemp(join(tmpdir(), "typescript-wasm-core-"));
  temporary.push(root);
  await writeFile(join(root, "main.ts"), text);
  const program = await loadCollectionModuleProgram(
      "main.ts",
      root,
      "evaluate",
    ),
    emitted = emitCollectionModuleWasm(program);
  return {
    root,
    program,
    runtime: instantiateCollectionModule(emitted.contract, emitted.bytes),
  };
}

describe("typed TypeScript without npm to native Wasm", () => {
  test("relative interfaces, nested fields, array methods, indexed for and independent TS agree", async () => {
    const root = resolve(import.meta.dir, "../examples/typescript-wasm-core"),
      program = await loadCollectionModuleProgram(
        "program.ts",
        root,
        "evaluate",
      ),
      emitted = emitCollectionModuleWasm(program),
      wasm = instantiateCollectionModule(emitted.contract, emitted.bytes),
      cases = [
        {
          input: {
            values: [1, -2, 3, 99, 10],
            settings: { multiplier: 2, threshold: 3 },
          },
          expected: { total: 8, selected: [6, 198, 20] },
        },
        {
          input: { values: [], settings: { multiplier: 5, threshold: 0 } },
          expected: { total: 0, selected: [] },
        },
        {
          input: {
            values: [-3, -1],
            settings: { multiplier: 2, threshold: -2 },
          },
          expected: { total: 0, selected: [-2] },
        },
      ];
    for (const item of cases) {
      expect(evaluate(item.input)).toEqual(item.expected);
      expect(evaluateCollectionProgram(program, item.input)).toEqual(
        item.expected,
      );
      expect(wasm.evaluate(item.input)).toEqual(item.expected);
    }
    const before = await readFile(join(root, "program.ts"), "utf8"),
      outputRoot = await mkdtemp(join(tmpdir(), "typescript-wasm-build-"));
    temporary.push(outputRoot);
    const manifest = await buildCollectionModuleProgram({
      entry: "program.ts",
      root,
      entryName: "evaluate",
      target: "all",
      outDir: join(outputRoot, "dist"),
    });
    expect(manifest.wasm?.contract.abi).toBe("llang-collection-native-v1");
    const suite = join(outputRoot, "suite.json");
    await writeFile(
      suite,
      JSON.stringify({
        format: "llang-module-suite",
        version: 3,
        profile: "module-collection-v1",
        interfaceHash: program.interfaceHash,
        cases: cases.map((item, i) => ({
          id: `case-${i}`,
          input: item.input,
          expected: { kind: "value", value: item.expected },
        })),
      }),
    );
    expect(
      (
        await testCollectionModuleProgram({
          entry: "program.ts",
          root,
          entryName: "evaluate",
          suite,
        })
      ).ok,
    ).toBe(true);
    expect(await readFile(join(root, "program.ts"), "utf8")).toBe(before);
  });

  test("for-of infers scalar element types and preserves record length fields", async () => {
    const { program, runtime } = await compile(`
      interface Input { values: ReadonlyArray<number>; length: number; }
      export function evaluate(input: Input): number {
        let total: number = input.length;
        for (const value of input.values) {
          if (value < 0) continue;
          total += value;
        }
        return total;
      }
    `);
    expect(
      evaluateCollectionProgram(program, { values: [2, -1, 5], length: 10 }),
    ).toBe(17);
    expect(runtime.evaluate({ values: [2, -1, 5], length: 10 })).toBe(17);
  });

  test("reduce, typed array literals and nested arrays are native", async () => {
    const { runtime } = await compile(`
      export function evaluate(input: number[][]): number {
        const empty: number[] = [];
        const initial: Array<number> = [2, 3];
        const base: number = initial.reduce((sum: number, value: number): number => sum + value, 0);
        const nested: number = input[0][0];
        return base + nested + empty.length;
      }
    `);
    expect(runtime.evaluate([[7]])).toBe(12);
    expect(() => runtime.evaluate([])).toThrow("INDEX_OUT_OF_BOUNDS");
    const constructors = await compile(`interface Inner { values: number[]; }
      interface Output { inner: Inner; }
      function sum(values: number[]): number { return values.reduce((a: number, b: number): number => a + b, 0); }
      export function evaluate(input: number): Output {
        return { inner: { values: [input, sum([2, 3])] } };
      }
    `);
    expect(constructors.runtime.evaluate(7)).toEqual({
      inner: { values: [7, 5] },
    });
  });

  test("nested for continue targets, reused loop bindings, return and decrement preserve control flow", async () => {
    const { runtime } = await compile(`
      export function evaluate(input: number): number {
        let total: number = 0;
        for (let i: number = 0; i < input; i++) {
          for (let j: number = 0; j < 3; j++) {
            if (j === 1) continue;
            total += i + j;
          }
          if (i === 1) continue;
          total += 10;
        }
        for (let i: number = 2; i > 0; --i) { total += i; }
        return total;
      }
    `);
    expect(runtime.evaluate(3)).toBe(35);
    const early =
      await compile(`export function evaluate(input: number): number {
      for (let i: number = 0; i < input; i++) { return i; } return -1;
    }`);
    expect(early.runtime.evaluate(2)).toBe(0);
    expect(early.runtime.evaluate(0)).toBe(-1);
    const branch =
      await compile(`export function evaluate(input: boolean): number {
      if (input) { const base: number = 3; return base + 2; }
      else { const base: number = 8; return base + 1; }
    }`);
    expect(branch.runtime.evaluate(true)).toBe(5);
    expect(branch.runtime.evaluate(false)).toBe(9);
    const shorthand = await compile(`interface Output { i: number; }
      export function evaluate(input: number): Output {
        for (let i: number = 0; i < input; i++) { return { i }; }
        return { i: -1 };
      }`);
    expect(shorthand.runtime.evaluate(2)).toEqual({ i: 0 });
  });

  test("checked integer faults and bounded input remain explicit", async () => {
    const { runtime } = await compile(
      `export function evaluate(input: number): number { let value: number = input; value *= 2; return value; }`,
    );
    expect(() => runtime.evaluate(2147483647)).toThrow("ARITHMETIC_OVERFLOW");
    expect(() => runtime.evaluate(0.5)).toThrow();
    const division = await compile(
      `export function evaluate(input: number): number { let value: number = 8; value /= input; return value; }`,
    );
    expect(() => division.runtime.evaluate(0)).toThrow("DIVISION_BY_ZERO");
  });

  test("switch break exits its case while for continues advancing", async () => {
    const { program, runtime } = await compile(`
      type Item = { tag: "add"; value: number } | { tag: "skip" };
      interface Input { item: Item; count: number; }
      export function evaluate(input: Input): number {
        const item: Item = input.item;
        let total: number = 0;
        for (let i: number = 0; i < input.count; i++) {
          switch (item.tag) {
            case "add": const amount: number = 2; total += amount; break;
            case "skip": continue;
          }
          total += 1;
        }
        return total;
      }
    `);
    for (const item of [
      { input: { item: { tag: "add", value: 2 }, count: 3 }, expected: 9 },
      { input: { item: { tag: "skip" }, count: 3 }, expected: 0 },
    ]) {
      expect(evaluateCollectionProgram(program, item.input)).toBe(
        item.expected,
      );
      expect(runtime.evaluate(item.input)).toBe(item.expected);
    }
  });

  test("record tag fields and reduce argument faults keep their meaning", async () => {
    const record =
      await compile(`interface Output { tag: string; value: number; }
      export function evaluate(input: number): Output { return { tag: "label", value: input }; }`);
    expect(record.runtime.evaluate(2)).toEqual({ tag: "label", value: 2 });
    const reduction = await compile(`
      export function evaluate(input: number[]): number {
        return input.reduce(
          input[0] > 0 ? (a: number, b: number): number => a + b : (a: number, b: number): number => a - b,
          1 / 0);
      }`);
    expect(() => evaluateCollectionProgram(reduction.program, [])).toThrow(
      "INDEX_OUT_OF_BOUNDS",
    );
    expect(() => reduction.runtime.evaluate([])).toThrow("INDEX_OUT_OF_BOUNDS");
    expect(() => reduction.runtime.evaluate([1])).toThrow("DIVISION_BY_ZERO");
    const conditional =
      await compile(`export function evaluate(input: number[]): number {
      return input.reduce(input[0] > 0
        ? (a: number, b: number): number => a + b
        : (a: number, b: number): number => a - b, 10);
    }`);
    expect(conditional.runtime.evaluate([1, 2])).toBe(13);
    expect(conditional.runtime.evaluate([-1, 2])).toBe(9);
  });

  test("npm imports, optional fields, mutation and optional chaining are rejected", async () => {
    for (const text of [
      `interface I { optional?: number; } export function evaluate(input: I): number { return 0; }`,
      `export function evaluate(input: number[]): number { input[0] = 2; return input[0]; }`,
      `export function evaluate(input: number[]): number { return input?.length; }`,
      `export async function evaluate(input: number): Promise<number> { return input; }`,
      `export function* evaluate(input: number): number { return input; }`,
      `export function evaluate(input: number[]): number { const length: number = 2; return input.length + length; }`,
      `export function evaluate(input: number[]): number { for await (const value of input) { return value; } return 0; }`,
      `export function evaluate(input: number[]): number[] { return input.map(async (value: number): number => value); }`,
      `export function evaluate(input: number[]): number[] { return input.map((value: number = 1): number => value); }`,
      `function helper(value: number): number { return value; } export function evaluate(input: number): number { return helper?.(input); }`,
      `import ignored, { List } from "llang:core"; export function evaluate(input: List<number>): number { return 0; }`,
      `import { length } from "llang:core"; export function evaluate(input: number[]): number { const length: number = 1; return input.length; }`,
      `interface Array<T> { value: T; } export function evaluate(input: Array<number>): number { return input.value; }`,
      `type I = { tag: "a" } | { tag: "b" }; export function evaluate(input: I): number { let result: number = 0; switch (input.tag) { case "a": result = 1; case "b": result = 2; break; } return result; }`,
      `type I = { tag: "a" } | { tag: "b" }; export function evaluate(input: I): number { let result: number = 0; while (result < 3) { switch (input.tag) { case "a": if (result === 1) break; result += 1; break; case "b": result += 1; break; } } return result; }`,
    ])
      await expect(compile(text)).rejects.toThrow();
    await expect(
      compile(
        `import { sum } from "some-package"; export function evaluate(input: number): number { return sum(input); }`,
      ),
    ).rejects.toThrow("invalid import path");
    expect(() =>
      parseCollectionModuleTypeScript(
        `export function evaluate(input: number): number { return +; }`,
      ),
    ).toThrow();
  });
});
