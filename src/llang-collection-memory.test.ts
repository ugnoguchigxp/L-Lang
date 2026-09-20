import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import binaryen from "binaryen";
import { CollectionDirectHarness } from "./llang-collection-direct-harness";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { instantiateCollectionModule } from "./llang-module-collection-runtime";
import { emitCollectionModuleWasm } from "./llang-module-collection-wasm";

const example = async () => {
  const program = await loadCollectionModuleProgram(
      "application/evaluate.llang.jsonc",
      "examples/module-order-batch",
      "evaluate",
    ),
    emitted = emitCollectionModuleWasm(program);
  return { program, emitted };
};

type DirectCorpus = {
  format: string;
  version: number;
  canonicalListSizes: number[];
  topLevelCases: {
    id: string;
    input: number;
    inputLength: number;
    output: number;
    outputCapacity: number;
  }[];
};

const directCorpus = async (): Promise<DirectCorpus> => {
  const value = JSON.parse(
    await readFile(
      "benchmarks/collection-memory-v1/fixtures/direct-corpus.json",
      "utf8",
    ),
  ) as DirectCorpus;
  if (
    value.format !== "llang-collection-direct-corpus" ||
    value.version !== 1 ||
    Object.keys(value).sort().join(",") !==
      "canonicalListSizes,format,topLevelCases,version" ||
    !Array.isArray(value.canonicalListSizes) ||
    value.canonicalListSizes.some(
      (size) => !Number.isSafeInteger(size) || size < 0 || size > 4_096,
    ) ||
    new Set(value.canonicalListSizes).size !==
      value.canonicalListSizes.length ||
    !Array.isArray(value.topLevelCases) ||
    value.topLevelCases.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Object.keys(item).sort().join(",") !==
          "id,input,inputLength,output,outputCapacity" ||
        typeof item.id !== "string" ||
        ![item.input, item.inputLength, item.output, item.outputCapacity].every(
          Number.isSafeInteger,
        ),
    ) ||
    new Set(value.topLevelCases.map((item) => item.id)).size !==
      value.topLevelCases.length
  )
    throw new Error("invalid direct corpus");
  return value;
};

const mutantHarness = (
  emitted: Awaited<ReturnType<typeof example>>["emitted"],
  replacements: [string, string][],
) => {
  let wat = emitted.wat;
  for (const [before, after] of replacements) {
    expect(wat).toContain(before);
    wat = wat.replace(before, after);
  }
  const module = binaryen.parseText(wat);
  try {
    expect(Boolean(module.validate())).toBe(true);
    return new CollectionDirectHarness(emitted.contract, module.emitBinary());
  } finally {
    module.dispose();
  }
};

describe("collection native memory boundary", () => {
  test("canonical direct ABI, host runtime and reference evaluator agree", async () => {
    const { program, emitted } = await example(),
      harness = new CollectionDirectHarness(emitted.contract, emitted.bytes),
      input = { values: [3, 1, 2], threshold: 2 },
      expected = evaluateCollectionProgram(program, input),
      hosted = instantiateCollectionModule(
        emitted.contract,
        emitted.bytes,
      ).evaluate(input),
      inputLength = harness.encodeInput(input),
      inputBefore = harness.memory.slice(64, 64 + inputLength),
      result = harness.invoke(64, inputLength);
    expect(result.kind).toBe("return");
    if (result.kind !== "return") return;
    expect(result.faultCode).toBe(0);
    expect(result.inputHashAfter).toBe(result.inputHashBefore);
    expect(harness.memory.slice(64, 64 + inputLength)).toEqual(inputBefore);
    expect(hosted).toEqual(expected);
    expect(harness.decodeOutput(524_288, result.outputLength)).toEqual(
      expected,
    );
  });

  test("fixed canonical boundary corpus preserves direct and hosted parity", async () => {
    const { program, emitted } = await example(),
      corpus = await directCorpus();
    for (const size of corpus.canonicalListSizes) {
      const input = {
          values: Array.from({ length: size }, (_, index) => index - 128),
          threshold: size === 4_096 ? 3_967 : -64,
        },
        expected = evaluateCollectionProgram(program, input),
        hosted = instantiateCollectionModule(
          emitted.contract,
          emitted.bytes,
        ).evaluate(input),
        harness = new CollectionDirectHarness(emitted.contract, emitted.bytes),
        inputLength = harness.encodeInput(input),
        result = harness.invoke(64, inputLength);
      expect(hosted).toEqual(expected);
      expect(result.kind).toBe("return");
      if (result.kind === "return")
        expect(harness.decodeOutput(524_288, result.outputLength)).toEqual(
          expected,
        );
    }
  });

  test("allocator exhaustion traps without writing beyond output capacity", async () => {
    const { emitted } = await example(),
      harness = new CollectionDirectHarness(emitted.contract, emitted.bytes),
      inputLength = harness.encodeInput({ values: [3, 2, 1], threshold: 0 }),
      output = 524_288,
      capacity = 12,
      canaryStart = output + capacity;
    harness.memory.fill(0xa5, canaryStart, canaryStart + 64);
    const result = harness.invoke(64, inputLength, output, capacity);
    expect(result.kind).toBe("trap");
    expect(result.faultCode).toBe(4);
    expect([...harness.memory.slice(canaryStart, canaryStart + 64)]).toEqual(
      Array(64).fill(0xa5),
    );
  });

  test("top-level truncation, wraparound and overlap fail before execution", async () => {
    const { emitted } = await example(),
      corpus = await directCorpus(),
      run = (input: number, length: number, output: number, capacity: number) =>
        new CollectionDirectHarness(emitted.contract, emitted.bytes).invoke(
          input,
          length,
          output,
          capacity,
        );
    for (const item of corpus.topLevelCases) {
      const result = run(
        item.input,
        item.inputLength,
        item.output,
        item.outputCapacity,
      );
      expect(result.kind).toBe("trap");
      expect(result.faultCode).toBe(5);
    }
  });

  test("List descriptors reject noncanonical empty and out-of-input payloads", async () => {
    const { emitted } = await example(),
      mutate = (change: (view: DataView) => void) => {
        const harness = new CollectionDirectHarness(
            emitted.contract,
            emitted.bytes,
          ),
          length = harness.encodeInput({ values: [1, 2], threshold: 0 }),
          view = new DataView(harness.memory.buffer);
        change(view);
        return harness.invoke(64, length);
      };
    for (const result of [
      mutate((view) => view.setUint32(68, 0, true)),
      mutate((view) => {
        view.setUint32(68, 80, true);
        view.setUint32(72, 0, true);
      }),
      mutate((view) => view.setUint32(68, 1_048_576, true)),
    ]) {
      expect(result.kind).toBe("trap");
      expect(result.faultCode).toBe(5);
    }
  });

  test("List descriptors reject root alias, misalignment and excessive count", async () => {
    const { emitted } = await example();
    const mutate = (change: (view: DataView) => void) => {
      const harness = new CollectionDirectHarness(
          emitted.contract,
          emitted.bytes,
        ),
        length = harness.encodeInput({ values: [1], threshold: 0 }),
        view = new DataView(harness.memory.buffer);
      change(view);
      return harness.invoke(64, length);
    };
    for (const result of [
      mutate((view) => view.setUint32(68, 68, true)),
      mutate((view) => view.setUint32(68, 77, true)),
      mutate((view) => view.setUint32(72, 4097, true)),
    ]) {
      expect(result.kind).toBe("trap");
      expect(result.faultCode).toBe(5);
    }

    const canary = new CollectionDirectHarness(emitted.contract, emitted.bytes),
      canaryLength = canary.encodeInput({ values: [1], threshold: 0 }),
      canaryView = new DataView(canary.memory.buffer),
      inputCanaryStart = 64 + canaryLength + 16,
      outputCanaryStart = 524_288 - 64;
    canaryView.setUint32(68, 68, true);
    const inputSnapshot = canary.memory.slice(64, 64 + canaryLength);
    canary.memory.fill(0xa5, inputCanaryStart, inputCanaryStart + 64);
    canary.memory.fill(0x5a, outputCanaryStart, outputCanaryStart + 64);
    const rejected = canary.invoke(64, canaryLength);
    expect(rejected.kind).toBe("trap");
    expect(rejected.inputHashAfter).toBe(rejected.inputHashBefore);
    expect(canary.memory.slice(64, 64 + canaryLength)).toEqual(inputSnapshot);
    expect([
      ...canary.memory.slice(inputCanaryStart, inputCanaryStart + 64),
    ]).toEqual(Array(64).fill(0xa5));
    expect([
      ...canary.memory.slice(outputCanaryStart, outputCanaryStart + 64),
    ]).toEqual(Array(64).fill(0x5a));
  });

  test("invalid UTF-8 is rejected by Wasm and a trapped instance stays poisoned", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-collection-memory-"));
    try {
      await writeFile(
        join(root, "main.ts"),
        `import { scalarLength } from "llang:core";
export type Input = { left: string; right: string; valid: boolean };
export function evaluate(input: Input): number { return scalarLength(input.left); }`,
      );
      const program = await loadCollectionModuleProgram(
          "main.ts",
          root,
          "evaluate",
        ),
        emitted = emitCollectionModuleWasm(program),
        harness = new CollectionDirectHarness(emitted.contract, emitted.bytes),
        length = harness.encodeInput({ left: "x", right: "y", valid: true }),
        view = new DataView(harness.memory.buffer),
        pointer = view.getUint32(64, true);
      harness.memory[pointer] = 0x80;
      const first = harness.invoke(64, length);
      expect(first.kind).toBe("trap");
      expect(first.faultCode).toBe(5);
      const second = harness.invoke(64, length);
      expect(second.kind).toBe("trap");
      expect(second.faultCode).toBe(5);

      const fresh = new CollectionDirectHarness(
          emitted.contract,
          emitted.bytes,
        ),
        freshLength = fresh.encodeInput({
          left: "ok",
          right: "safe",
          valid: true,
        }),
        valid = fresh.invoke(64, freshLength);
      expect(valid.kind).toBe("return");

      const alias = new CollectionDirectHarness(
          emitted.contract,
          emitted.bytes,
        ),
        aliasLength = alias.encodeInput({
          left: "a",
          right: "b",
          valid: true,
        }),
        aliasView = new DataView(alias.memory.buffer);
      aliasView.setUint32(72, aliasView.getUint32(64, true), true);
      const aliased = alias.invoke(64, aliasLength);
      expect(aliased.kind).toBe("trap");
      expect(aliased.faultCode).toBe(5);

      const invalidBoolean = new CollectionDirectHarness(
          emitted.contract,
          emitted.bytes,
        ),
        booleanLength = invalidBoolean.encodeInput({
          left: "a",
          right: "b",
          valid: true,
        });
      new DataView(invalidBoolean.memory.buffer).setUint32(80, 2, true);
      const booleanResult = invalidBoolean.invoke(64, booleanLength);
      expect(booleanResult.kind).toBe("trap");
      expect(booleanResult.faultCode).toBe(5);

      const scalar = new CollectionDirectHarness(
          emitted.contract,
          emitted.bytes,
        ),
        scalarLength = scalar.encodeInput({
          left: "\u{10ffff}",
          right: "safe",
          valid: true,
        }),
        scalarResult = scalar.invoke(64, scalarLength);
      expect(scalarResult.kind).toBe("return");
      if (scalarResult.kind === "return")
        expect(scalar.decodeOutput(524_288, scalarResult.outputLength)).toBe(1);

      const maximum = new CollectionDirectHarness(
          emitted.contract,
          emitted.bytes,
        ),
        maximumLength = maximum.encodeInput({
          left: "a".repeat(16_384),
          right: "",
          valid: true,
        }),
        maximumResult = maximum.invoke(64, maximumLength);
      expect(maximumResult.kind).toBe("return");
      if (maximumResult.kind === "return")
        expect(maximum.decodeOutput(524_288, maximumResult.outputLength)).toBe(
          16_384,
        );

      const oversized = new CollectionDirectHarness(
          emitted.contract,
          emitted.bytes,
        ),
        oversizedLength = oversized.encodeInput({
          left: "x",
          right: "",
          valid: true,
        });
      new DataView(oversized.memory.buffer).setUint32(68, 16_385, true);
      const oversizedResult = oversized.invoke(64, oversizedLength);
      expect(oversizedResult.kind).toBe("trap");
      expect(oversizedResult.faultCode).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Union tags and nested payload aliases are rejected before match", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "llang-collection-union-memory-"),
    );
    try {
      const literal = (value: number) => ({
        kind: "literal",
        type: "i32",
        value,
      });
      await writeFile(
        join(root, "main.llang.jsonc"),
        JSON.stringify({
          language: "l-lang",
          version: 4,
          kind: "module",
          profile: "module-collection-v1",
          imports: [],
          types: [
            {
              name: "Input",
              export: true,
              kind: "union",
              typeParameters: [],
              variants: [
                {
                  tag: "Value",
                  fields: [{ name: "text", type: "string" }],
                },
                { tag: "Empty", fields: [] },
              ],
            },
          ],
          functions: [
            {
              name: "evaluate",
              export: true,
              typeParameters: [],
              parameters: [{ name: "input", type: { ref: "Input" } }],
              returns: "i32",
              body: {
                statements: [
                  {
                    kind: "match",
                    value: { kind: "param", name: "input" },
                    cases: [
                      {
                        tag: "Value",
                        body: [{ kind: "return", value: literal(1) }],
                      },
                      {
                        tag: "Empty",
                        body: [{ kind: "return", value: literal(0) }],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }),
      );
      const program = await loadCollectionModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        ),
        emitted = emitCollectionModuleWasm(program),
        invokeMutation = (change: (view: DataView) => void) => {
          const harness = new CollectionDirectHarness(
              emitted.contract,
              emitted.bytes,
            ),
            length = harness.encodeInput({ tag: "Value", text: "x" }),
            view = new DataView(harness.memory.buffer);
          change(view);
          return harness.invoke(64, length);
        };
      for (const result of [
        invokeMutation((view) => view.setUint32(64, 2, true)),
        invokeMutation((view) => view.setUint32(68, 64, true)),
      ]) {
        expect(result.kind).toBe("trap");
        expect(result.faultCode).toBe(5);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allocator accepts an exactly fitting aligned payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-collection-exact-arena-"));
    try {
      await writeFile(
        join(root, "main.ts"),
        `export type Input = { value: string };
export function evaluate(input: Input): string { return input.value; }`,
      );
      const program = await loadCollectionModuleProgram(
          "main.ts",
          root,
          "evaluate",
        ),
        emitted = emitCollectionModuleWasm(program),
        harness = new CollectionDirectHarness(emitted.contract, emitted.bytes),
        length = harness.encodeInput({ value: "x" }),
        result = harness.invoke(64, length, 524_288, 9);
      expect(result.kind).toBe("return");
      if (result.kind === "return") {
        expect(result.outputLength).toBe(9);
        expect(harness.decodeOutput(524_288, result.outputLength)).toBe("x");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fixed corpus distinguishes the five frozen boundary mutants", async () => {
    const { emitted } = await example();

    const ignoredLength = mutantHarness(emitted, [
      [
        "local.get $inputLength i32.const 12 i32.lt_u i32.or",
        "i32.const 0 i32.or",
      ],
      [
        "local.get $inputLength local.get $memoryBytes local.get $input i32.sub i32.gt_u i32.or",
        "i32.const 0 i32.or",
      ],
      [
        "local.get $input local.get $inputLength i32.add local.set $inputEnd",
        "local.get $input i32.const 262144 i32.add local.set $inputEnd",
      ],
      [
        "local.get $input local.get $inputLength local.get $output local.get $capacity local.get $memoryBytes call $prepareClaims",
        "local.get $input i32.const 262144 local.get $output local.get $capacity local.get $memoryBytes call $prepareClaims",
      ],
    ]);
    expect(ignoredLength.invoke(64, 4).kind).toBe("return");

    const uncheckedAllocation = mutantHarness(emitted, [
      [
        "local.get $size local.get $remaining i32.gt_u if i32.const 4 call $fail end",
        "nop",
      ],
    ]);
    const uncheckedLength = uncheckedAllocation.encodeInput({
        values: [3, 2, 1],
        threshold: 0,
      }),
      uncheckedCanary = uncheckedAllocation.memory.slice(524_304, 524_336);
    const uncheckedResult = uncheckedAllocation.invoke(
      64,
      uncheckedLength,
      524_288,
      16,
    );
    expect(uncheckedResult.kind).toBe("trap");
    expect(uncheckedAllocation.memory.slice(524_304, 524_336)).not.toEqual(
      uncheckedCanary,
    );

    const unaligned = mutantHarness(emitted, [
      [
        "local.get $pointer i32.const 3 i32.and\n          if i32.const 5 call $fail end",
        "nop",
      ],
    ]);
    const unalignedLength = unaligned.encodeInput({
        values: [1, 2],
        threshold: 0,
      }),
      unalignedView = new DataView(unaligned.memory.buffer),
      originalPointer = unalignedView.getUint32(68, true);
    unalignedView.setUint32(68, originalPointer + 1, true);
    unalignedView.setUint32(72, 1, true);
    expect(unaligned.invoke(64, unalignedLength).kind).toBe("return");

    const skippedNested = mutantHarness(emitted, [
      ["local.get $input call $validate0", "nop"],
    ]);
    const skippedLength = skippedNested.encodeInput({
      values: [1],
      threshold: 0,
    });
    new DataView(skippedNested.memory.buffer).setUint32(68, 68, true);
    expect(skippedNested.invoke(64, skippedLength).kind).toBe("return");

    const continuedAfterFault = mutantHarness(emitted, [
      [
        "local.get $code global.set $fault unreachable",
        "local.get $code global.set $fault",
      ],
    ]);
    const continued = continuedAfterFault.invoke(64, 4);
    expect(continued.kind).toBe("return");
    expect(continued.faultCode).toBe(5);
  });
});
