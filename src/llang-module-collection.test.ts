import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import binaryen from "binaryen";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import { emitCollectionModuleTypeScript } from "./llang-module-collection-source-emitter";
import { emitCollectionModuleWasm } from "./llang-module-collection-wasm";
import { instantiateCollectionModule } from "./llang-module-collection-runtime";
import {
  buildCollectionModuleProgram,
  readCollectionModuleBuildManifest,
} from "./llang-module-collection-build";
import {
  parseCollectionModuleSuite,
  testCollectionModuleProgram,
  verifyCollectionModuleBundle,
} from "./llang-module-collection-suite";
import {
  decodeCollectionFromMemory,
  encodeCollectionToMemory,
} from "./llang-collection-abi";
import type { CollectionType } from "./llang-module-collection-ir";
import { canonicalCollectionType } from "./llang-module-collection-ir";
import {
  instantiateLegacyCollectionModule,
  type LegacyCollectionWasmContract,
} from "./llang-module-collection-legacy-runtime";
import { fingerprintFor } from "./stable-hash";

const local = (name: string) => ({ kind: "local", name });
const field = (base: object, name: string) => ({ kind: "field", base, name });
const callIntrinsic = (name: string, args: object[]) => ({
  kind: "intrinsic",
  name,
  typeArguments: [],
  arguments: args,
});
const lambda = (
  parameters: { name: string; type: unknown }[],
  returns: unknown,
  result: object,
) => ({
  kind: "lambda",
  parameters,
  returns,
  body: { statements: [], result },
});
const source = {
  language: "l-lang",
  version: 4,
  kind: "module",
  profile: "module-collection-v1",
  imports: [],
  types: [
    {
      name: "Input",
      export: true,
      kind: "record",
      typeParameters: [],
      fields: [
        { name: "values", type: { list: "i32" } },
        { name: "threshold", type: "i32" },
      ],
    },
    {
      name: "Output",
      export: true,
      kind: "record",
      typeParameters: [],
      fields: [
        { name: "values", type: { list: "i32" } },
        { name: "total", type: "i32" },
      ],
    },
  ],
  functions: [
    {
      name: "evaluate",
      export: true,
      typeParameters: [],
      parameters: [{ name: "input", type: { ref: "Input" } }],
      returns: { ref: "Output" },
      body: {
        statements: [
          {
            kind: "const",
            name: "filtered",
            type: { list: "i32" },
            value: callIntrinsic("filter", [
              field(local("input"), "values"),
              lambda([{ name: "value", type: "i32" }], "boolean", {
                kind: "binary",
                op: ">=",
                left: local("value"),
                right: field(local("input"), "threshold"),
              }),
            ]),
          },
          {
            kind: "const",
            name: "sorted",
            type: { list: "i32" },
            value: callIntrinsic("stableSort", [
              local("filtered"),
              lambda(
                [
                  { name: "left", type: "i32" },
                  { name: "right", type: "i32" },
                ],
                "i32",
                {
                  kind: "binary",
                  op: "-",
                  left: local("left"),
                  right: local("right"),
                },
              ),
            ]),
          },
          {
            kind: "const",
            name: "total",
            type: "i32",
            value: callIntrinsic("fold", [
              local("sorted"),
              { kind: "literal", type: "i32", value: 0 },
              lambda(
                [
                  { name: "sum", type: "i32" },
                  { name: "value", type: "i32" },
                ],
                "i32",
                {
                  kind: "binary",
                  op: "+",
                  left: local("sum"),
                  right: local("value"),
                },
              ),
            ]),
          },
        ],
        result: {
          kind: "record",
          type: "Output",
          typeArguments: [],
          fields: [
            { name: "values", value: local("sorted") },
            { name: "total", value: local("total") },
          ],
        },
      },
    },
  ],
};

describe("module-collection-v1", () => {
  test("List callbacks, capture, fold and stable sort agree across reference, generated TS and Wasm contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-collection-"));
    try {
      await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(source));
      const program = await loadCollectionModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        ),
        input = { values: [5, 2, 5, 1, 3], threshold: 2 },
        expected = { values: [2, 3, 5, 5], total: 15 };
      expect(evaluateCollectionProgram(program, input)).toEqual(expected);
      const generated = join(root, "generated.ts");
      await writeFile(generated, emitCollectionModuleTypeScript(program));
      const imported = await import(`${generated}?v=${Date.now()}`);
      expect(imported.evaluate(input)).toEqual(expected);
      const wasm = emitCollectionModuleWasm(program);
      expect(
        instantiateCollectionModule(wasm.contract, wasm.bytes).evaluate(input),
      ).toEqual(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("List values are persistent and out-of-range access is deterministic", async () => {
    const copy = structuredClone(source) as any;
    copy.functions[0].body = {
      statements: [
        {
          kind: "const",
          name: "original",
          type: { list: "i32" },
          value: field(local("input"), "values"),
        },
        {
          kind: "const",
          name: "updated",
          type: { list: "i32" },
          value: callIntrinsic("set", [
            local("original"),
            { kind: "literal", type: "i32", value: 0 },
            { kind: "literal", type: "i32", value: 9 },
          ]),
        },
      ],
      result: {
        kind: "record",
        type: "Output",
        typeArguments: [],
        fields: [
          { name: "values", value: local("original") },
          {
            name: "total",
            value: callIntrinsic("at", [
              local("updated"),
              { kind: "literal", type: "i32", value: 0 },
            ]),
          },
        ],
      },
    };
    const root = await mkdtemp(join(tmpdir(), "llang-collection-"));
    try {
      await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(copy));
      const program = await loadCollectionModuleProgram(
        "main.llang.jsonc",
        root,
        "evaluate",
      );
      expect(
        evaluateCollectionProgram(program, { values: [1], threshold: 0 }),
      ).toEqual({ values: [1], total: 9 });
      expect(() =>
        evaluateCollectionProgram(program, { values: [], threshold: 0 }),
      ).toThrow("INDEX_OUT_OF_BOUNDS");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("TypeScript frontend supports typed List, callbacks, let and for-of", async () => {
    const text = `import { List, fold } from "llang:core";
export type Input = { values: List<number>; threshold: number };
export type Output = { total: number };
export function evaluate(input: Input): Output {
  let total: number = 0;
  for (const value: number of input.values) { total = total + value; }
  return ({ total: total } as Output);
}`;
    const root = await mkdtemp(join(tmpdir(), "llang-collection-ts-"));
    try {
      await writeFile(join(root, "main.ts"), text);
      const program = await loadCollectionModuleProgram(
        "main.ts",
        root,
        "evaluate",
      );
      expect(
        evaluateCollectionProgram(program, { values: [1, 2, 3], threshold: 0 }),
      ).toEqual({ total: 6 });
      const native = emitCollectionModuleWasm(program);
      expect(
        instantiateCollectionModule(native.contract, native.bytes).evaluate({
          values: [1, 2, 3],
          threshold: 0,
        }),
      ).toEqual({ total: 6 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("version-4 native bundle verifies without source or compiler", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-collection-build-"));
    try {
      await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(source));
      const program = await loadCollectionModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        ),
        suite = {
          format: "llang-module-suite",
          version: 3,
          profile: "module-collection-v1",
          interfaceHash: program.interfaceHash,
          cases: [
            {
              id: "batch",
              input: { values: [5, 2, 1, 3], threshold: 2 },
              expected: {
                kind: "value",
                value: { values: [2, 3, 5], total: 10 },
              },
            },
            {
              id: "invalid-input",
              input: { values: [1, 2] },
              expected: { kind: "invalid-input" },
            },
          ],
        };
      const suitePath = join(root, "suite.json");
      await writeFile(suitePath, JSON.stringify(suite));
      expect(
        (
          await testCollectionModuleProgram({
            entry: "main.llang.jsonc",
            root,
            entryName: "evaluate",
            suite: suitePath,
          })
        ).ok,
      ).toBe(true);
      const out = join(root, "bundle");
      await buildCollectionModuleProgram({
        entry: "main.llang.jsonc",
        root,
        entryName: "evaluate",
        target: "all",
        outDir: out,
      });
      await rm(join(root, "main.llang.jsonc"));
      expect(
        (
          await verifyCollectionModuleBundle(
            join(out, "module-build.json"),
            suitePath,
          )
        ).ok,
      ).toBe(true);
      const manifestPath = join(out, "module-build.json"),
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.unexpected = true;
      await writeFile(manifestPath, JSON.stringify(manifest));
      expect(readCollectionModuleBuildManifest(manifestPath)).rejects.toThrow(
        "invalid collection manifest keys",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("explicit generics and direct recursion share deterministic call limits", async () => {
    const recursive: any = {
      language: "l-lang",
      version: 4,
      kind: "module",
      profile: "module-collection-v1",
      imports: [],
      types: [
        {
          name: "Input",
          export: true,
          kind: "record",
          typeParameters: [],
          fields: [{ name: "value", type: "i32" }],
        },
      ],
      functions: [
        {
          name: "identity",
          export: false,
          typeParameters: ["T"],
          parameters: [{ name: "value", type: { ref: "T" } }],
          returns: { ref: "T" },
          body: { statements: [], result: local("value") },
        },
        {
          name: "count",
          export: false,
          typeParameters: [],
          parameters: [{ name: "value", type: "i32" }],
          returns: "i32",
          body: {
            statements: [],
            result: {
              kind: "if",
              condition: {
                kind: "binary",
                op: "<=",
                left: local("value"),
                right: { kind: "literal", type: "i32", value: 0 },
              },
              // biome-ignore lint/suspicious/noThenProperty: public JSONC IR key.
              then: { kind: "literal", type: "i32", value: 0 },
              else: {
                kind: "binary",
                op: "+",
                left: { kind: "literal", type: "i32", value: 1 },
                right: {
                  kind: "call",
                  callee: "count",
                  typeArguments: [],
                  arguments: [
                    {
                      kind: "binary",
                      op: "-",
                      left: local("value"),
                      right: { kind: "literal", type: "i32", value: 1 },
                    },
                  ],
                },
              },
            },
          },
        },
        {
          name: "evaluate",
          export: true,
          typeParameters: [],
          parameters: [{ name: "input", type: { ref: "Input" } }],
          returns: "i32",
          body: {
            statements: [],
            result: {
              kind: "call",
              callee: "identity",
              typeArguments: ["i32"],
              arguments: [
                {
                  kind: "call",
                  callee: "count",
                  typeArguments: [],
                  arguments: [field(local("input"), "value")],
                },
              ],
            },
          },
        },
      ],
    };
    const root = await mkdtemp(join(tmpdir(), "llang-collection-recursion-"));
    try {
      await writeFile(
        join(root, "main.llang.jsonc"),
        JSON.stringify(recursive),
      );
      const program = await loadCollectionModuleProgram(
        "main.llang.jsonc",
        root,
        "evaluate",
      );
      expect(evaluateCollectionProgram(program, { value: 10 })).toBe(10);
      const native = emitCollectionModuleWasm(program),
        runtime = instantiateCollectionModule(native.contract, native.bytes);
      expect(runtime.evaluate({ value: 10 })).toBe(10);
      expect(program.instances.some((x) => x.includes("identity"))).toBe(true);
      expect(() => evaluateCollectionProgram(program, { value: 65 })).toThrow(
        "call depth exceeded",
      );
      expect(() => runtime.evaluate({ value: 65 })).toThrow("RESOURCE_LIMIT");
      recursive.functions[2].body.result.typeArguments = [];
      await writeFile(join(root, "bad.llang.jsonc"), JSON.stringify(recursive));
      expect(
        loadCollectionModuleProgram("bad.llang.jsonc", root, "evaluate"),
      ).rejects.toThrow("explicit type arguments");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returned closures retain immutable captures and reject let captures", async () => {
    const closure: any = {
      language: "l-lang",
      version: 4,
      kind: "module",
      profile: "module-collection-v1",
      imports: [],
      types: [
        {
          name: "Input",
          export: true,
          kind: "record",
          typeParameters: [],
          fields: [
            { name: "base", type: "i32" },
            { name: "value", type: "i32" },
          ],
        },
      ],
      functions: [
        {
          name: "makeAdder",
          export: false,
          typeParameters: [],
          parameters: [{ name: "base", type: "i32" }],
          returns: { function: { parameters: ["i32"], returns: "i32" } },
          body: {
            statements: [],
            result: lambda([{ name: "value", type: "i32" }], "i32", {
              kind: "binary",
              op: "+",
              left: local("base"),
              right: local("value"),
            }),
          },
        },
        {
          name: "evaluate",
          export: true,
          typeParameters: [],
          parameters: [{ name: "input", type: { ref: "Input" } }],
          returns: "i32",
          body: {
            statements: [
              {
                kind: "const",
                name: "adder",
                type: { function: { parameters: ["i32"], returns: "i32" } },
                value: {
                  kind: "call",
                  callee: "makeAdder",
                  typeArguments: [],
                  arguments: [field(local("input"), "base")],
                },
              },
            ],
            result: {
              kind: "invoke",
              callee: local("adder"),
              arguments: [field(local("input"), "value")],
            },
          },
        },
      ],
    };
    const root = await mkdtemp(join(tmpdir(), "llang-collection-closure-"));
    try {
      await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(closure));
      const program = await loadCollectionModuleProgram(
        "main.llang.jsonc",
        root,
        "evaluate",
      );
      expect(evaluateCollectionProgram(program, { base: 4, value: 6 })).toBe(
        10,
      );
      const native = emitCollectionModuleWasm(program);
      expect(
        instantiateCollectionModule(native.contract, native.bytes).evaluate({
          base: 4,
          value: 6,
        }),
      ).toBe(10);
      closure.functions[0].body = {
        statements: [
          { kind: "let", name: "captured", type: "i32", value: local("base") },
        ],
        result: lambda([{ name: "value", type: "i32" }], "i32", {
          kind: "binary",
          op: "+",
          left: local("captured"),
          right: local("value"),
        }),
      };
      await writeFile(join(root, "bad.llang.jsonc"), JSON.stringify(closure));
      expect(
        loadCollectionModuleProgram("bad.llang.jsonc", root, "evaluate"),
      ).rejects.toThrow("cannot capture mutable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("collection ABI uses canonical List descriptors and rejects overlap", () => {
    const type: CollectionType = { kind: "list", element: { kind: "string" } },
      memory = new Uint8Array(1024),
      length = encodeCollectionToMemory(memory, type, ["商品", "A"], 64, 512);
    expect([...memory.slice(64, 72)]).toEqual([72, 0, 0, 0, 2, 0, 0, 0]);
    expect(decodeCollectionFromMemory(memory, type, 64, length)).toEqual([
      "商品",
      "A",
    ]);
    new DataView(memory.buffer).setUint32(72, 72, true);
    new DataView(memory.buffer).setUint32(76, 1, true);
    expect(() => decodeCollectionFromMemory(memory, type, 64, length)).toThrow(
      "overlapping wire payload",
    );
    const empty = new Uint8Array(32);
    encodeCollectionToMemory(empty, type, [], 8, 16);
    expect([...empty.slice(8, 16)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("native output promotion deep-copies nested input payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-collection-promote-"));
    const passThrough = {
      language: "l-lang",
      version: 4,
      kind: "module",
      profile: "module-collection-v1",
      imports: [],
      types: [
        {
          name: "Input",
          export: true,
          kind: "record",
          typeParameters: [],
          fields: [{ name: "values", type: { list: "string" } }],
        },
      ],
      functions: [
        {
          name: "evaluate",
          export: true,
          typeParameters: [],
          parameters: [{ name: "input", type: { ref: "Input" } }],
          returns: { ref: "Input" },
          body: { statements: [], result: local("input") },
        },
      ],
    };
    try {
      await writeFile(
        join(root, "main.llang.jsonc"),
        JSON.stringify(passThrough),
      );
      const program = await loadCollectionModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        ),
        native = emitCollectionModuleWasm(program),
        runtime = instantiateCollectionModule(native.contract, native.bytes);
      expect(runtime.evaluate({ values: ["商品", "", "A"] })).toEqual({
        values: ["商品", "", "A"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("untrusted ABI values and suite shapes are rejected strictly", () => {
    const record: CollectionType = {
      kind: "record",
      symbol: "test#Input",
      arguments: [],
      fields: [{ name: "name", type: { kind: "string" } }],
    };
    expect(() =>
      encodeCollectionToMemory(
        new Uint8Array(128),
        record,
        { name: "ok", extra: true },
        0,
        128,
      ),
    ).toThrow("invalid object fields");
    expect(() =>
      encodeCollectionToMemory(
        new Uint8Array(128),
        record,
        { name: "\ud800" },
        0,
        128,
      ),
    ).toThrow("invalid Unicode string");
    expect(() =>
      encodeCollectionToMemory(new Uint8Array(8), { kind: "i32" }, 1, 8, 1),
    ).toThrow("invalid wire destination");
    expect(() =>
      parseCollectionModuleSuite({
        format: "llang-module-suite",
        version: 3,
        profile: "module-collection-v1",
        interfaceHash: "0".repeat(64),
        cases: [
          {
            id: "bad",
            input: {},
            expected: { kind: "invalid-input", extra: true },
          },
        ],
      }),
    ).toThrow("invalid collection suite expectation");
  });

  test("TypeScript core names require explicit valid imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-collection-imports-"));
    try {
      await writeFile(
        join(root, "main.ts"),
        `export type Input = { values: List<number> };
export function evaluate(input: Input): number { return length(input.values); }`,
      );
      expect(
        loadCollectionModuleProgram("main.ts", root, "evaluate"),
      ).rejects.toThrow("List must be imported from llang:core");
      await writeFile(
        join(root, "main.ts"),
        `import { List, mystery } from "llang:core";
export type Input = { values: List<number> };
export function evaluate(input: Input): number { return 0; }`,
      );
      expect(
        loadCollectionModuleProgram("main.ts", root, "evaluate"),
      ).rejects.toThrow("invalid llang:core import");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("portable runtime invokes the native Wasm ABI export", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-collection-wasm-call-"));
    try {
      await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(source));
      const program = await loadCollectionModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        ),
        emitted = emitCollectionModuleWasm(program),
        replacement = binaryen.parseText(`(module
          (memory (export "memory") 128 128)
          (func (export "fault_code") (result i32) (i32.const 0))
          (func (export "evaluate") (param i32 i32 i32 i32) (result i32)
            (i32.const 0)))`);
      try {
        const runtime = instantiateCollectionModule(
          emitted.contract,
          new Uint8Array(replacement.emitBinary()),
        );
        expect(() => runtime.evaluate({ values: [], threshold: 0 })).toThrow(
          "invalid native output length",
        );
      } finally {
        replacement.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("legacy shell ABI remains explicit and isolated from native runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-collection-legacy-"));
    try {
      await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(source));
      const program = await loadCollectionModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        ),
        legacyLayoutHash = fingerprintFor({
          abi: "llang-collection-memory-v1",
          input: canonicalCollectionType(program.entryInput),
          output: canonicalCollectionType(program.entryOutput),
        }),
        { modules: _modules, ...nativeExecutable } = program,
        executable = { ...nativeExecutable, layoutHash: legacyLayoutHash },
        contract: LegacyCollectionWasmContract = {
          abi: "llang-collection-memory-v1",
          memory: { initial: 128, maximum: 128 },
          inputType: program.entryInput,
          outputType: program.entryOutput,
          layoutHash: legacyLayoutHash,
          programHash: program.programHash,
          loweredHash: program.loweredHash,
          executableHash: fingerprintFor(executable),
          executable,
        },
        shell = binaryen.parseText(`(module
          (memory (export "memory") 128 128)
          (func (export "evaluate") (param i32 i32 i32 i32) (result i32)
            (i32.const 5)))`);
      try {
        expect(
          instantiateLegacyCollectionModule(
            contract,
            new Uint8Array(shell.emitBinary()),
          ).evaluate({ values: [3, 1, 2], threshold: 2 }),
        ).toEqual({ values: [2, 3], total: 5 });
        const native = emitCollectionModuleWasm(program);
        expect(() =>
          instantiateCollectionModule(
            contract as unknown as typeof native.contract,
            native.bytes,
          ),
        ).toThrow("invalid collection ABI contract");
      } finally {
        shell.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("native lowering covers strings, map, append, variants and match", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-collection-native-wide-"));
    const wide: any = {
      language: "l-lang",
      version: 4,
      kind: "module",
      profile: "module-collection-v1",
      imports: [],
      types: [
        {
          name: "Input",
          export: true,
          kind: "record",
          typeParameters: [],
          fields: [{ name: "names", type: { list: "string" } }],
        },
        {
          name: "Result",
          export: true,
          kind: "union",
          typeParameters: [],
          variants: [
            {
              tag: "Ok",
              fields: [{ name: "values", type: { list: "string" } }],
            },
            { tag: "Empty", fields: [] },
          ],
        },
      ],
      functions: [
        {
          name: "count",
          export: false,
          typeParameters: [],
          parameters: [{ name: "result", type: { ref: "Result" } }],
          returns: "i32",
          body: {
            statements: [
              {
                kind: "match",
                value: local("result"),
                cases: [
                  {
                    tag: "Ok",
                    body: [
                      {
                        kind: "return",
                        value: { kind: "literal", type: "i32", value: 1 },
                      },
                    ],
                  },
                  {
                    tag: "Empty",
                    body: [
                      {
                        kind: "return",
                        value: { kind: "literal", type: "i32", value: 0 },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        {
          name: "evaluate",
          export: true,
          typeParameters: [],
          parameters: [{ name: "input", type: { ref: "Input" } }],
          returns: "i32",
          body: {
            statements: [
              {
                kind: "const",
                name: "mapped",
                type: { list: "string" },
                value: callIntrinsic("map", [
                  field(local("input"), "names"),
                  lambda([{ name: "name", type: "string" }], "string", {
                    kind: "intrinsic",
                    name: "concat",
                    typeArguments: [],
                    arguments: [
                      local("name"),
                      { kind: "literal", type: "string", value: "!" },
                    ],
                  }),
                ]),
              },
              {
                kind: "const",
                name: "appended",
                type: { list: "string" },
                value: callIntrinsic("append", [
                  local("mapped"),
                  { kind: "literal", type: "string", value: "done" },
                ]),
              },
            ],
            result: {
              kind: "call",
              callee: "count",
              typeArguments: [],
              arguments: [
                {
                  kind: "variant",
                  type: "Result",
                  typeArguments: [],
                  tag: "Ok",
                  fields: [{ name: "values", value: local("appended") }],
                },
              ],
            },
          },
        },
      ],
    };
    try {
      await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(wide));
      const program = await loadCollectionModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        ),
        native = emitCollectionModuleWasm(program),
        runtime = instantiateCollectionModule(native.contract, native.bytes);
      expect(evaluateCollectionProgram(program, { names: ["A", "商品"] })).toBe(
        1,
      );
      expect(runtime.evaluate({ names: ["A", "商品"] })).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
