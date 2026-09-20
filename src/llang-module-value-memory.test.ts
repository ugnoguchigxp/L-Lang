import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import binaryen from "binaryen";
import { ValueDirectHarness } from "./llang-module-value-direct-harness";
import { evaluateValueProgram } from "./llang-module-value-evaluator";
import { loadValueModuleProgram } from "./llang-module-value-loader";
import { instantiateValueModule } from "./llang-module-value-runtime";
import { emitValueModuleWasm } from "./llang-module-value-wasm";
import {
  renderValueMemorySafetyMatrix,
  type ValueMemorySafetyMatrix,
} from "./llang-value-memory-matrix";
import { layoutValueType } from "./llang-value-abi";

type DirectCorpus = {
  format: "llang-value-direct-corpus";
  version: 1;
  canonicalInputs: Record<string, unknown>[];
  topLevelCases: {
    id: string;
    input: number;
    inputLength: number;
    output: number;
    outputCapacity: number;
  }[];
  stringCases: {
    id: string;
    pointer: number;
    length: number;
    expectedStatus: number;
  }[];
};

const example = async () => {
  const program = await loadValueModuleProgram(
      "application/quote.llang.jsonc",
      "examples/module-order-line",
      "quote",
    ),
    emitted = emitValueModuleWasm(program);
  return { program, emitted };
};

const corpus = async () =>
  JSON.parse(
    await readFile("benchmarks/value-memory-v1/direct-corpus.json", "utf8"),
  ) as DirectCorpus;

async function programFixture(source: object) {
  const root = await mkdtemp(join(tmpdir(), "llang-value-memory-"));
  await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(source));
  return {
    root,
    program: await loadValueModuleProgram("main.llang.jsonc", root, "evaluate"),
  };
}

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
    return new ValueDirectHarness(emitted.contract, module.emitBinary());
  } finally {
    module.dispose();
  }
};

const stringFieldOffset = (
  type: Awaited<ReturnType<typeof example>>["program"]["entryInput"],
) => {
  const field = layoutValueType(type).fields?.find(
    (item) => item.name === "productCode",
  );
  if (!field) throw new Error("missing productCode layout");
  return field.offset;
};

describe("module-value-v1 direct memory boundary", () => {
  test("fixed canonical corpus agrees across reference, hosted and direct execution", async () => {
    const { program, emitted } = await example(),
      fixed = await corpus();
    expect(fixed.format).toBe("llang-value-direct-corpus");
    expect(fixed.version).toBe(1);
    for (const input of fixed.canonicalInputs) {
      const expected = evaluateValueProgram(program, input),
        hosted = instantiateValueModule(
          emitted.contract,
          emitted.bytes,
        ).evaluate(input),
        direct = new ValueDirectHarness(emitted.contract, emitted.bytes),
        inputLength = direct.encodeInput(input),
        snapshot = direct.memory.slice(64, 64 + inputLength),
        result = direct.invoke(64, inputLength);
      expect(hosted).toEqual(expected);
      expect(result.kind).toBe("return");
      if (result.kind !== "return") continue;
      expect(result.status).toBe(0);
      expect(result.inputHashAfter).toBe(result.inputHashBefore);
      expect(direct.memory.slice(64, 64 + inputLength)).toEqual(snapshot);
      expect(direct.decodeOutput()).toEqual(expected);
    }
  });

  test("top-level malformed ranges and overlap return status 1 before writes", async () => {
    const { emitted } = await example(),
      fixed = await corpus();
    for (const item of fixed.topLevelCases) {
      const direct = new ValueDirectHarness(emitted.contract, emitted.bytes),
        outputStart =
          item.output >= 0 && item.output < direct.memory.length
            ? item.output
            : 131_072,
        canaryStart = Math.min(outputStart, direct.memory.length - 64);
      direct.memory.fill(0xa5, canaryStart, canaryStart + 64);
      const before = direct.memory.slice(canaryStart, canaryStart + 64),
        result = direct.invoke(
          item.input,
          item.inputLength,
          item.output,
          item.outputCapacity,
        );
      expect(result.kind, item.id).toBe("return");
      if (result.kind === "return") expect(result.status, item.id).toBe(1);
      expect(direct.memory.slice(canaryStart, canaryStart + 64)).toEqual(
        before,
      );
    }
  });

  test("invalid string ranges never reach the UTF-8 reader", async () => {
    const { program, emitted } = await example(),
      fixed = await corpus(),
      offset = stringFieldOffset(program.entryInput);
    for (const item of fixed.stringCases) {
      const direct = new ValueDirectHarness(emitted.contract, emitted.bytes),
        inputLength = direct.encodeInput({
          member: false,
          productCode: "x",
          quantity: 1,
          unitPrice: 1,
        }),
        view = new DataView(direct.memory.buffer);
      view.setUint32(64 + offset, item.pointer, true);
      view.setUint32(64 + offset + 4, item.length, true);
      direct.memory.fill(0x5a, 131_072, 131_136);
      const outputBefore = direct.memory.slice(131_072, 131_136),
        result = direct.invoke(64, inputLength);
      expect(result.kind, item.id).toBe("return");
      if (result.kind === "return")
        expect(result.status, item.id).toBe(item.expectedStatus);
      expect(result.inputHashAfter, item.id).toBe(result.inputHashBefore);
      expect(direct.memory.slice(131_072, 131_136)).toEqual(outputBefore);
    }
  });

  test("boolean, UTF-8 and exact string limits are checked without trapping", async () => {
    const { program, emitted } = await example(),
      offset = stringFieldOffset(program.entryInput),
      invalidBoolean = new ValueDirectHarness(emitted.contract, emitted.bytes),
      booleanLength = invalidBoolean.encodeInput({
        member: false,
        productCode: "x",
        quantity: 1,
        unitPrice: 1,
      });
    new DataView(invalidBoolean.memory.buffer).setUint32(64, 2, true);
    const booleanResult = invalidBoolean.invoke(64, booleanLength);
    expect(booleanResult.kind).toBe("return");
    if (booleanResult.kind === "return") expect(booleanResult.status).toBe(1);

    for (const bytes of [
      [0x80],
      [0xc0, 0x80],
      [0xe0, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
    ]) {
      const direct = new ValueDirectHarness(emitted.contract, emitted.bytes),
        inputLength = direct.encodeInput({
          member: false,
          productCode: "xxxx",
          quantity: 1,
          unitPrice: 1,
        }),
        view = new DataView(direct.memory.buffer),
        pointer = view.getUint32(64 + offset, true);
      direct.memory.set(bytes, pointer);
      view.setUint32(64 + offset + 4, bytes.length, true);
      const result = direct.invoke(64, inputLength);
      expect(result.kind).toBe("return");
      if (result.kind === "return") expect(result.status).toBe(1);
    }

    const maximum = new ValueDirectHarness(emitted.contract, emitted.bytes),
      maximumLength = maximum.encodeInput({
        member: false,
        productCode: "a".repeat(16_384),
        quantity: 1,
        unitPrice: 1,
      }),
      maximumResult = maximum.invoke(64, maximumLength);
    expect(maximumResult.kind).toBe("return");
    if (maximumResult.kind === "return") expect(maximumResult.status).toBe(0);
  });

  test("safe aliasing and unaligned contained buffers remain compatible", async () => {
    const { program, emitted } = await example(),
      direct = new ValueDirectHarness(emitted.contract, emitted.bytes),
      input = {
        member: false,
        productCode: "alias",
        quantity: 1,
        unitPrice: 2,
      },
      length = direct.encodeInput(input, 65, 65_536),
      result = direct.invoke(65, length, 200_001, 65_536);
    expect(result.kind).toBe("return");
    if (result.kind === "return") expect(result.status).toBe(0);
    expect(direct.decodeOutput(200_001)).toEqual(
      evaluateValueProgram(program, input),
    );
  });

  test("a rejected input leaves the synchronous instance reusable", async () => {
    const { program, emitted } = await example(),
      direct = new ValueDirectHarness(emitted.contract, emitted.bytes),
      offset = stringFieldOffset(program.entryInput),
      input = {
        member: false,
        productCode: "ok",
        quantity: 2,
        unitPrice: 3,
      },
      length = direct.encodeInput(input),
      view = new DataView(direct.memory.buffer);
    view.setUint32(64 + offset, 0xffffffff, true);
    const rejected = direct.invoke(64, length);
    expect(rejected.kind).toBe("return");
    if (rejected.kind === "return") expect(rejected.status).toBe(1);
    const validLength = direct.encodeInput(input),
      valid = direct.invoke(64, validLength);
    expect(valid.kind).toBe("return");
    if (valid.kind === "return") expect(valid.status).toBe(0);
    expect(direct.decodeOutput()).toEqual(evaluateValueProgram(program, input));
  });

  test("insufficient output capacity returns resource status without decoding", async () => {
    const { emitted } = await example(),
      direct = new ValueDirectHarness(emitted.contract, emitted.bytes),
      length = direct.encodeInput({
        member: false,
        productCode: "output",
        quantity: 1,
        unitPrice: 2,
      }),
      output = 131_072,
      capacity = layoutValueType(direct.outputType).size;
    const result = direct.invoke(64, length, output, capacity);
    expect(result.kind).toBe("return");
    if (result.kind === "return") expect(result.status).toBe(4);
    expect(result.inputHashAfter).toBe(result.inputHashBefore);
  });

  test("checked-in corpus and matrix satisfy schemas and generated Markdown", async () => {
    const load = async (path: string) =>
        JSON.parse(await readFile(path, "utf8")),
      corpusSchema = await load("schemas/value-direct-corpus-v1.schema.json"),
      directCorpus = (await load(
        "benchmarks/value-memory-v1/direct-corpus.json",
      )) as DirectCorpus,
      schema = await load("schemas/value-memory-safety-matrix-v1.schema.json"),
      matrix = (await load(
        "benchmarks/value-memory-v1/memory-safety-matrix.json",
      )) as ValueMemorySafetyMatrix,
      ajv = new Ajv2020({ strict: true }),
      validateCorpus = ajv.compile(corpusSchema),
      validate = ajv.compile(schema),
      caseIds = [
        ...directCorpus.topLevelCases.map((item) => item.id),
        ...directCorpus.stringCases.map((item) => item.id),
      ];
    expect(validateCorpus(directCorpus)).toBe(true);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    expect(validate(matrix)).toBe(true);
    expect(new Set(matrix.entries.map((entry) => entry.id)).size).toBe(
      matrix.entries.length,
    );
    expect(
      await readFile("docs/VALUE_WASM_MEMORY_SAFETY_MATRIX.md", "utf8"),
    ).toBe(renderValueMemorySafetyMatrix(matrix));
  });

  test("fixed cases distinguish boundary-check mutants", async () => {
    const { program, emitted } = await example(),
      offset = stringFieldOffset(program.entryInput);

    const eager = mutantHarness(emitted, [
      [
        `(if (i32.lt_u (local.get $validation_ptr0) (local.get $input)) (then (return (i32.const 1))))`,
        "(nop)",
      ],
      [
        `(if (i32.gt_u (local.get $validation_ptr0) (local.get $input_end)) (then (return (i32.const 1))))`,
        "(nop)",
      ],
      [
        `(if (i32.gt_u (local.get $validation_len0) (i32.sub (local.get $input_end) (local.get $validation_ptr0))) (then (return (i32.const 1))))`,
        "(nop)",
      ],
    ]);
    const eagerLength = eager.encodeInput({
      member: false,
      productCode: "x",
      quantity: 1,
      unitPrice: 1,
    });
    new DataView(eager.memory.buffer).setUint32(64 + offset, 0xffffffff, true);
    expect(eager.invoke(64, eagerLength).kind).toBe("trap");

    const ignoredLength = mutantHarness(emitted, [
      [
        `(if (i32.lt_u (local.get $input_len) (i32.const 20)) (then (return (i32.const 1))))`,
        "(nop)",
      ],
    ]);
    ignoredLength.encodeInput({
      member: false,
      productCode: "x",
      quantity: 1,
      unitPrice: 1,
    });
    new DataView(ignoredLength.memory.buffer).setUint32(64 + offset, 64, true);
    new DataView(ignoredLength.memory.buffer).setUint32(
      64 + offset + 4,
      0,
      true,
    );
    const ignoredResult = ignoredLength.invoke(64, 19);
    expect(ignoredResult.kind).toBe("return");
    if (ignoredResult.kind === "return") expect(ignoredResult.status).toBe(0);

    const signed = mutantHarness(emitted, [
      [
        `(i32.gt_u (local.get $input) (i32.const 1048576))`,
        `(i32.gt_s (local.get $input) (i32.const 1048576))`,
      ],
    ]);
    expect(signed.invoke(-16, 20).kind).toBe("trap");

    const overlap = mutantHarness(emitted, [
      [
        `(i32.and (i32.lt_u (local.get $input) (local.get $output_end)) (i32.lt_u (local.get $output) (local.get $input_end)))`,
        `(i32.const 0)`,
      ],
    ]);
    const overlapLength = overlap.encodeInput({
      member: false,
      productCode: "x",
      quantity: 1,
      unitPrice: 1,
    });
    const overlapResult = overlap.invoke(64, overlapLength, 64, 64);
    expect(overlapResult.kind).toBe("return");
    if (overlapResult.kind === "return")
      expect(overlapResult.status).not.toBe(1);

    const uncheckedOutput = mutantHarness(emitted, [
      [
        `(if (i32.gt_u (call $len (local.get $v)) (i32.sub (global.get $out_end) (local.get $p))) (then (global.set $fault (i32.const 4)) (return (i32.const 0))))`,
        "(nop)",
      ],
      [
        `(if (i32.gt_u (local.get $padding) (i32.sub (global.get $out_end) (local.get $next))) (then (global.set $fault (i32.const 4)) (return (i32.const 0))))`,
        "(nop)",
      ],
    ]);
    const uncheckedLength = uncheckedOutput.encodeInput({
        member: false,
        productCode: "output",
        quantity: 1,
        unitPrice: 2,
      }),
      rootSize = layoutValueType(uncheckedOutput.outputType).size,
      canaryStart = 131_072 + rootSize;
    uncheckedOutput.memory.fill(0xa5, canaryStart, canaryStart + 64);
    const uncheckedResult = uncheckedOutput.invoke(
      64,
      uncheckedLength,
      131_072,
      rootSize,
    );
    expect(uncheckedResult.kind).toBe("return");
    if (uncheckedResult.kind === "return")
      expect(uncheckedResult.status).toBe(0);
  });

  test("selected-variant case detects validation of an inactive union payload", async () => {
    const fixture = await programFixture({
      language: "l-lang",
      version: 3,
      kind: "module",
      profile: "module-value-v1",
      imports: [],
      types: [
        {
          name: "Choice",
          export: false,
          kind: "union",
          variants: [
            { tag: "left", fields: [{ name: "amount", type: "i32" }] },
            { tag: "right", fields: [{ name: "text", type: "string" }] },
          ],
        },
        {
          name: "Input",
          export: true,
          kind: "record",
          fields: [{ name: "choice", type: { ref: "Choice" } }],
        },
      ],
      functions: [
        {
          name: "evaluate",
          export: true,
          parameters: [{ name: "input", type: { ref: "Input" } }],
          returns: "i32",
          body: {
            kind: "match",
            value: {
              kind: "field",
              base: { kind: "param", name: "input" },
              name: "choice",
            },
            cases: [
              { tag: "left", body: { kind: "local", name: "amount" } },
              {
                tag: "right",
                body: {
                  kind: "intrinsic",
                  name: "scalarLength",
                  arguments: [{ kind: "local", name: "text" }],
                },
              },
            ],
          },
        },
      ],
    });
    try {
      const emitted = emitValueModuleWasm(fixture.program),
        valid = new ValueDirectHarness(emitted.contract, emitted.bytes),
        input = { choice: { tag: "left", amount: 9 } },
        validLength = valid.encodeInput(input),
        validResult = valid.invoke(64, validLength);
      expect(validResult.kind).toBe("return");
      if (validResult.kind === "return") expect(validResult.status).toBe(0);

      const rootLayout = layoutValueType(fixture.program.entryInput),
        choiceField = rootLayout.fields?.find(
          (field) => field.name === "choice",
        );
      if (!choiceField) throw new Error("missing nested choice layout");
      const rightVariant = layoutValueType(choiceField.type).variants?.find(
          (variant) => variant.tag === "right",
        ),
        textField = rightVariant?.fields.find((field) => field.name === "text");
      if (!textField) throw new Error("missing selected string layout");
      const nested = new ValueDirectHarness(emitted.contract, emitted.bytes),
        nestedLength = nested.encodeInput({
          choice: { tag: "right", text: "ok" },
        }),
        nestedView = new DataView(nested.memory.buffer);
      nestedView.setUint32(
        64 + choiceField.offset + textField.offset,
        0xffffffff,
        true,
      );
      const nestedResult = nested.invoke(64, nestedLength);
      expect(nestedResult.kind).toBe("return");
      if (nestedResult.kind === "return") expect(nestedResult.status).toBe(1);
      expect(nestedResult.inputHashAfter).toBe(nestedResult.inputHashBefore);
      expect(nestedResult.outputHashAfter).toBe(nestedResult.outputHashBefore);

      const mutant = mutantHarness(emitted, [
          [
            `(i32.eq (local.get $validation_tag0) (i32.const 1))`,
            `(i32.const 1)`,
          ],
        ]),
        mutantLength = mutant.encodeInput(input),
        mutantResult = mutant.invoke(64, mutantLength);
      expect(mutantResult.kind).toBe("return");
      if (mutantResult.kind === "return") expect(mutantResult.status).toBe(1);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("allocation-exhaustion case detects a removed remaining-capacity guard", async () => {
    const constant = "a".repeat(16_384),
      fixture = await programFixture({
        language: "l-lang",
        version: 3,
        kind: "module",
        profile: "module-value-v1",
        imports: [],
        types: [
          {
            name: "Input",
            export: true,
            kind: "record",
            fields: [{ name: "value", type: "i32" }],
          },
        ],
        functions: [
          {
            name: "evaluate",
            export: true,
            parameters: [{ name: "input", type: { ref: "Input" } }],
            returns: "i32",
            body: {
              kind: "block",
              bindings: Array.from({ length: 60 }, (_, index) => ({
                name: `s${index}`,
                type: "string",
                value: { kind: "literal", type: "string", value: constant },
              })),
              result: {
                kind: "field",
                base: { kind: "param", name: "input" },
                name: "value",
              },
            },
          },
        ],
      });
    try {
      const emitted = emitValueModuleWasm(fixture.program),
        safe = new ValueDirectHarness(emitted.contract, emitted.bytes),
        safeLength = safe.encodeInput({ value: 1 }),
        safeResult = safe.invoke(64, safeLength, 131_072, 4);
      expect(safeResult.kind).toBe("return");
      if (safeResult.kind === "return") expect(safeResult.status).toBe(4);

      const mutant = mutantHarness(emitted, [
          [
            `(if (i32.gt_u (local.get $n) (i32.sub (i32.const 1048576) (local.get $p))) (then (global.set $fault (i32.const 4)) (return (i32.const 0))))`,
            `(nop)`,
          ],
        ]),
        mutantLength = mutant.encodeInput({ value: 1 }),
        mutantResult = mutant.invoke(64, mutantLength, 131_072, 4);
      expect(mutantResult.kind).toBe("trap");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
