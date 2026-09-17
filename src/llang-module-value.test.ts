import { describe, expect, test } from "bun:test";
import binaryen from "binaryen";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadValueModuleProgram,
  parseValueModuleTypeScript,
} from "./llang-module-value-loader";
import { evaluateValueProgram } from "./llang-module-value-evaluator";
import { emitValueModuleWasm } from "./llang-module-value-wasm";
import { instantiateValueModule } from "./llang-module-value-runtime";
import { emitValueModuleTypeScript } from "./llang-module-value-source-emitter";
import {
  decodeValueFromMemory,
  encodeValueToMemory,
  layoutValueType,
} from "./llang-value-abi";
import { buildValueModuleProgram } from "./llang-module-value-build";
import { verifyValueModuleBundle } from "./llang-module-value-suite";
import type { ValueType } from "./llang-module-value-ir";
import { digest } from "./wasm-contract";

async function fixture(
  source: object,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "llang-value-fixture-"));
  try {
    await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(source));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function moduleSource(
  body: object,
  returns: unknown = "i32",
  fields: { name: string; type: unknown }[] = [{ name: "value", type: "i32" }],
  types: object[] = [],
): object {
  return {
    language: "l-lang",
    version: 3,
    kind: "module",
    profile: "module-value-v1",
    imports: [],
    types: [{ name: "Input", export: true, kind: "record", fields }, ...types],
    functions: [
      {
        name: "evaluate",
        export: true,
        parameters: [{ name: "input", type: { ref: "Input" } }],
        returns,
        body,
      },
    ],
  };
}
const paramField = (name: string) => ({
  kind: "field",
  base: { kind: "param", name: "input" },
  name,
});

describe("module-value-v1", () => {
  test("TypeScript string intrinsics require explicit value imports", () => {
    const body =
      "export function length(value: string): number { return scalarLength(value); }";
    expect(() => parseValueModuleTypeScript(body)).toThrow(
      "must be imported from llang:core",
    );
    expect(() =>
      parseValueModuleTypeScript(
        `import type { scalarLength } from "llang:core"; ${body}`,
      ),
    ).toThrow("invalid llang:core import");
    expect(
      parseValueModuleTypeScript(
        `import { scalarLength } from "llang:core"; ${body}`,
      ).functions,
    ).toHaveLength(1);
  });

  test("TypeScript and JSONC frontends produce one typed program and all four backends agree", async () => {
    const json = await loadValueModuleProgram(
        "application/quote.llang.jsonc",
        "examples/module-order-line",
        "quote",
      ),
      ts = await loadValueModuleProgram(
        "application/quote.ts",
        "examples/module-order-line",
        "quote",
      );
    expect(ts.programHash).toBe(json.programHash);
    expect(ts.interfaceHash).toBe(json.interfaceHash);
    expect(ts.layoutHash).toBe(json.layoutHash);
    const input = {
        member: false,
        productCode: "商品A",
        quantity: 3,
        unitPrice: 200,
      },
      expected = { tag: "ok", label: "商品A", total: 600 };
    expect(evaluateValueProgram(ts, input)).toEqual(expected);
    expect(evaluateValueProgram(json, input)).toEqual(expected);
    const emitted = emitValueModuleWasm(ts);
    expect(
      instantiateValueModule(emitted.contract, emitted.bytes).evaluate(input),
    ).toEqual(expected);
  });

  test("checked i32 arithmetic matches exact boundaries and faults", async () => {
    await fixture(
      moduleSource({
        kind: "binary",
        op: "*",
        left: paramField("value"),
        right: { kind: "literal", type: "i32", value: 2 },
      }),
      async (root) => {
        const program = await loadValueModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        );
        expect(evaluateValueProgram(program, { value: -3 })).toBe(-6);
        expect(() =>
          evaluateValueProgram(program, { value: 2147483647 }),
        ).toThrow("ARITHMETIC_OVERFLOW");
        expect(() =>
          instantiateValueModule(
            emitValueModuleWasm(program).contract,
            emitValueModuleWasm(program).bytes,
          ).evaluate({ value: 2147483647 }),
        ).toThrow("ARITHMETIC_OVERFLOW");
      },
    );
    await fixture(
      moduleSource({
        kind: "binary",
        op: "/",
        left: paramField("value"),
        right: { kind: "literal", type: "i32", value: 0 },
      }),
      async (root) => {
        const program = await loadValueModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        );
        expect(() => evaluateValueProgram(program, { value: 1 })).toThrow(
          "DIVISION_BY_ZERO",
        );
      },
    );
  });

  test("fuel exhaustion remains the first Wasm fault", async () => {
    const functions: object[] = [
      {
        name: "f0",
        export: false,
        parameters: [],
        returns: "i32",
        body: { kind: "literal", type: "i32", value: 1 },
      },
    ];
    for (let index = 1; index <= 17; index++)
      functions.push({
        name: `f${index}`,
        export: false,
        parameters: [],
        returns: "i32",
        body: {
          kind: "binary",
          op: "/",
          left: { kind: "call", callee: `f${index - 1}`, arguments: [] },
          right: { kind: "call", callee: `f${index - 1}`, arguments: [] },
        },
      });
    functions.push({
      name: "evaluate",
      export: true,
      parameters: [{ name: "input", type: { ref: "Input" } }],
      returns: "i32",
      body: { kind: "call", callee: "f17", arguments: [] },
    });
    await fixture(
      {
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
        functions,
      },
      async (root) => {
        const program = await loadValueModuleProgram(
            "main.llang.jsonc",
            root,
            "evaluate",
          ),
          emitted = emitValueModuleWasm(program);
        expect(() => evaluateValueProgram(program, { value: 0 })).toThrow(
          "RESOURCE_LIMIT",
        );
        expect(() =>
          instantiateValueModule(emitted.contract, emitted.bytes).evaluate({
            value: 0,
          }),
        ).toThrow("RESOURCE_LIMIT");
      },
    );
  });

  test("Unicode scalar length, concat, NUL and lone-surrogate rejection are consistent", async () => {
    const body = {
      kind: "intrinsic",
      name: "scalarLength",
      arguments: [
        {
          kind: "intrinsic",
          name: "concat",
          arguments: [paramField("left"), paramField("right")],
        },
      ],
    };
    await fixture(
      moduleSource(body, "i32", [
        { name: "left", type: "string" },
        { name: "right", type: "string" },
      ]),
      async (root) => {
        const program = await loadValueModuleProgram(
            "main.llang.jsonc",
            root,
            "evaluate",
          ),
          input = { left: "😀\0", right: "e\u0301" };
        expect(evaluateValueProgram(program, input)).toBe(4);
        expect(
          instantiateValueModule(
            emitValueModuleWasm(program).contract,
            emitValueModuleWasm(program).bytes,
          ).evaluate(input),
        ).toBe(4);
        expect(() =>
          evaluateValueProgram(program, { left: "\ud800", right: "" }),
        ).toThrow("lone surrogate");
      },
    );
  });

  test("unselected branches do not evaluate faults", async () => {
    const body = Object.fromEntries([
      ["kind", "if"],
      ["condition", { kind: "literal", type: "boolean", value: false }],
      [
        // biome-ignore lint/suspicious/noThenProperty: the public JSONC IR names this branch "then".
        "then",
        {
          kind: "binary",
          op: "/",
          left: { kind: "literal", type: "i32", value: 1 },
          right: { kind: "literal", type: "i32", value: 0 },
        },
      ],
      ["else", { kind: "literal", type: "i32", value: 7 }],
    ]);
    await fixture(moduleSource(body), async (root) => {
      const program = await loadValueModuleProgram(
        "main.llang.jsonc",
        root,
        "evaluate",
      );
      expect(evaluateValueProgram(program, { value: 0 })).toBe(7);
      expect(
        instantiateValueModule(
          emitValueModuleWasm(program).contract,
          emitValueModuleWasm(program).bytes,
        ).evaluate({ value: 0 }),
      ).toBe(7);
    });
  });

  test("block scope and exhaustive match expose only selected payload", async () => {
    const types = [
        {
          name: "Choice",
          export: false,
          kind: "union",
          variants: [
            { tag: "left", fields: [{ name: "amount", type: "i32" }] },
            { tag: "right", fields: [{ name: "text", type: "string" }] },
          ],
        },
      ],
      body = {
        kind: "match",
        value: paramField("choice"),
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
      };
    await fixture(
      moduleSource(
        body,
        "i32",
        [{ name: "choice", type: { ref: "Choice" } }],
        types,
      ),
      async (root) => {
        const program = await loadValueModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        );
        expect(
          evaluateValueProgram(program, { choice: { tag: "left", amount: 9 } }),
        ).toBe(9);
        expect(
          instantiateValueModule(
            emitValueModuleWasm(program).contract,
            emitValueModuleWasm(program).bytes,
          ).evaluate({ choice: { tag: "right", text: "😀x" } }),
        ).toBe(2);
      },
    );
  });

  test("ABI codec has deterministic little-endian layout and rejects bad tags", () => {
    const type: ValueType = {
        kind: "record",
        symbol: "x#R",
        fields: [
          { name: "a", type: { kind: "boolean" } },
          { name: "n", type: { kind: "i32" } },
          { name: "s", type: { kind: "string" } },
        ],
      },
      memory = new Uint8Array(256);
    expect(layoutValueType(type).size).toBe(16);
    const used = encodeValueToMemory(
      memory,
      type,
      { a: true, n: -2, s: "A" },
      64,
      64,
    );
    expect([...memory.slice(64, 80)]).toEqual([
      1, 0, 0, 0, 254, 255, 255, 255, 80, 0, 0, 0, 1, 0, 0, 0,
    ]);
    expect(used).toBe(20);
    expect(decodeValueFromMemory(memory, type, 64, 64)).toEqual({
      a: true,
      n: -2,
      s: "A",
    });
  });

  test("Wasm rejects overlapping wire buffers in its entry prologue", async () => {
    const program = await loadValueModuleProgram(
        "application/quote.llang.jsonc",
        "examples/module-order-line",
        "quote",
      ),
      emitted = emitValueModuleWasm(program),
      instance = new WebAssembly.Instance(
        new WebAssembly.Module(emitted.bytes as BufferSource),
      ),
      evaluate = instance.exports.evaluate as (
        a: number,
        b: number,
        c: number,
        d: number,
      ) => number;
    expect(evaluate(64, 64, 96, 64)).toBe(1);
  });

  test("Wasm resolves imported type aliases used by constructors", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-value-alias-"));
    try {
      await writeFile(
        join(root, "types.llang.jsonc"),
        JSON.stringify({
          language: "l-lang",
          version: 3,
          kind: "module",
          profile: "module-value-v1",
          imports: [],
          types: [
            {
              name: "Request",
              export: true,
              kind: "record",
              fields: [{ name: "value", type: "i32" }],
            },
            {
              name: "Response",
              export: true,
              kind: "union",
              variants: [
                { tag: "error", fields: [{ name: "message", type: "string" }] },
                { tag: "ok", fields: [{ name: "value", type: "i32" }] },
              ],
            },
          ],
          functions: [],
        }),
      );
      await writeFile(
        join(root, "main.llang.jsonc"),
        JSON.stringify({
          language: "l-lang",
          version: 3,
          kind: "module",
          profile: "module-value-v1",
          imports: [
            {
              from: "./types.llang.jsonc",
              bindings: [
                { kind: "type", name: "Request", as: "InputAlias" },
                { kind: "type", name: "Response", as: "OutputAlias" },
              ],
            },
          ],
          types: [],
          functions: [
            {
              name: "evaluate",
              export: true,
              parameters: [{ name: "input", type: { ref: "InputAlias" } }],
              returns: { ref: "OutputAlias" },
              body: {
                kind: "variant",
                type: "OutputAlias",
                tag: "ok",
                fields: [{ name: "value", value: paramField("value") }],
              },
            },
          ],
        }),
      );
      const program = await loadValueModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        ),
        emitted = emitValueModuleWasm(program);
      expect(
        instantiateValueModule(emitted.contract, emitted.bytes).evaluate({
          value: 41,
        }),
      ).toEqual({ tag: "ok", value: 41 });
      const privateTypes = JSON.parse(
        await readFile(join(root, "types.llang.jsonc"), "utf8"),
      );
      privateTypes.types[1].export = false;
      await writeFile(
        join(root, "types.llang.jsonc"),
        JSON.stringify(privateTypes),
      );
      await expect(
        loadValueModuleProgram("main.llang.jsonc", root, "evaluate"),
      ).rejects.toThrow("type Response is not exported");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("separate block scopes may reuse a local name with different types", async () => {
    await fixture(
      moduleSource(
        {
          kind: "if",
          condition: paramField("flag"),
          // biome-ignore lint/suspicious/noThenProperty: `then` is part of the module-value IR schema, not a Promise-like object.
          then: {
            kind: "block",
            bindings: [
              {
                name: "item",
                type: { ref: "NumberBox" },
                value: {
                  kind: "record",
                  type: "NumberBox",
                  fields: [
                    {
                      name: "number",
                      value: { kind: "literal", type: "i32", value: 7 },
                    },
                  ],
                },
              },
            ],
            result: {
              kind: "field",
              base: { kind: "local", name: "item" },
              name: "number",
            },
          },
          else: {
            kind: "block",
            bindings: [
              {
                name: "item",
                type: { ref: "TextBox" },
                value: {
                  kind: "record",
                  type: "TextBox",
                  fields: [
                    {
                      name: "text",
                      value: { kind: "literal", type: "string", value: "ab" },
                    },
                  ],
                },
              },
            ],
            result: {
              kind: "intrinsic",
              name: "scalarLength",
              arguments: [
                {
                  kind: "field",
                  base: { kind: "local", name: "item" },
                  name: "text",
                },
              ],
            },
          },
        },
        "i32",
        [{ name: "flag", type: "boolean" }],
        [
          {
            name: "NumberBox",
            export: false,
            kind: "record",
            fields: [{ name: "number", type: "i32" }],
          },
          {
            name: "TextBox",
            export: false,
            kind: "record",
            fields: [{ name: "text", type: "string" }],
          },
        ],
      ),
      async (root) => {
        const program = await loadValueModuleProgram(
            "main.llang.jsonc",
            root,
            "evaluate",
          ),
          runtime = instantiateValueModule(
            emitValueModuleWasm(program).contract,
            emitValueModuleWasm(program).bytes,
          );
        expect(runtime.evaluate({ flag: true })).toBe(7);
        expect(runtime.evaluate({ flag: false })).toBe(2);
      },
    );
  });

  test("generated TypeScript preserves outer locals across match cases", async () => {
    await fixture(
      moduleSource(
        {
          kind: "block",
          bindings: [
            { name: "saved", type: "i32", value: paramField("value") },
          ],
          result: {
            kind: "match",
            value: paramField("choice"),
            cases: [
              { tag: "left", body: { kind: "local", name: "saved" } },
              { tag: "right", body: { kind: "local", name: "saved" } },
            ],
          },
        },
        "i32",
        [
          { name: "choice", type: { ref: "Choice" } },
          { name: "value", type: "i32" },
        ],
        [
          {
            name: "Choice",
            export: false,
            kind: "union",
            variants: [
              { tag: "left", fields: [{ name: "a", type: "i32" }] },
              { tag: "right", fields: [{ name: "b", type: "i32" }] },
            ],
          },
        ],
      ),
      async (root) => {
        const program = await loadValueModuleProgram(
            "main.llang.jsonc",
            root,
            "evaluate",
          ),
          generated = join(root, "program.generated.ts");
        await writeFile(generated, emitValueModuleTypeScript(program));
        const module = (await import(`${generated}?review=${Date.now()}`)) as {
          evaluate(input: unknown): unknown;
        };
        expect(
          module.evaluate({ choice: { tag: "left", a: 1 }, value: 9 }),
        ).toBe(9);
        class Input {
          choice = { tag: "right", b: 1 };
          value = 9;
        }
        expect(() => module.evaluate(new Input())).toThrow("INVALID_INPUT");
      },
    );
  });

  test("Wasm string literals cannot be overwritten by ABI buffers", async () => {
    await fixture(
      moduleSource(
        { kind: "literal", type: "string", value: "constant" },
        "string",
      ),
      async (root) => {
        const program = await loadValueModuleProgram(
            "main.llang.jsonc",
            root,
            "evaluate",
          ),
          emitted = emitValueModuleWasm(program),
          instance = new WebAssembly.Instance(
            new WebAssembly.Module(emitted.bytes as BufferSource),
          ),
          memory = new Uint8Array(
            (instance.exports.memory as WebAssembly.Memory).buffer,
          ),
          inputLength = encodeValueToMemory(
            memory,
            program.entryInput,
            { value: 1 },
            64,
            64,
          ),
          evaluate = instance.exports.evaluate as (
            a: number,
            b: number,
            c: number,
            d: number,
          ) => number;
        expect(evaluate(64, inputLength, 262144, 64)).toBe(0);
        expect(
          decodeValueFromMemory(memory, program.entryOutput, 262144, 64),
        ).toBe("constant");
        expect(evaluate(64, inputLength, 900000, 64)).toBe(0);
        expect(
          decodeValueFromMemory(memory, program.entryOutput, 900000, 64),
        ).toBe("constant");
      },
    );
  });

  test("Wasm ABI rejects invalid UTF-8 and payloads above 64 KiB", async () => {
    await fixture(
      moduleSource(
        {
          kind: "intrinsic",
          name: "scalarLength",
          arguments: [paramField("text")],
        },
        "i32",
        [{ name: "text", type: "string" }],
      ),
      async (root) => {
        const program = await loadValueModuleProgram(
            "main.llang.jsonc",
            root,
            "evaluate",
          ),
          emitted = emitValueModuleWasm(program),
          instance = new WebAssembly.Instance(
            new WebAssembly.Module(emitted.bytes as BufferSource),
          ),
          memory = new Uint8Array(
            (instance.exports.memory as WebAssembly.Memory).buffer,
          ),
          view = new DataView(memory.buffer),
          evaluate = instance.exports.evaluate as (
            a: number,
            b: number,
            c: number,
            d: number,
          ) => number;
        view.setUint32(64, 80, true);
        view.setUint32(68, 1, true);
        memory[80] = 0x80;
        expect(evaluate(64, 32, 128, 64)).toBe(1);
        expect(evaluate(64, 65537, 131072, 64)).toBe(1);
        expect(evaluate(64, 32, 131072, 65537)).toBe(1);
        expect(evaluate(-16, 32, 131072, 64)).toBe(1);
        expect(evaluate(64, 32, -16, 64)).toBe(1);
      },
    );
  });

  test("runtime distinguishes invalid-artifact and unknown Wasm statuses", async () => {
    const program = await loadValueModuleProgram(
        "application/quote.llang.jsonc",
        "examples/module-order-line",
        "quote",
      ),
      contract = emitValueModuleWasm(program).contract,
      moduleFor = (status: number) => {
        const module = binaryen.parseText(
          `(module (memory (export "memory") 16 16) (func (export "evaluate") (param i32 i32 i32 i32) (result i32) (i32.const ${status})))`,
        );
        try {
          return new Uint8Array(module.emitBinary());
        } finally {
          module.dispose();
        }
      };
    const validInput = {
      member: false,
      productCode: "x",
      quantity: 1,
      unitPrice: 1,
    };
    expect(() =>
      instantiateValueModule(contract, moduleFor(5)).evaluate(validInput),
    ).toThrow("INVALID_ARTIFACT");
    expect(() =>
      instantiateValueModule(contract, moduleFor(99)).evaluate(validInput),
    ).toThrow("unknown Wasm status 99");
    const growing = binaryen.parseText(
      `(module (memory (export "memory") 16 17) (func (export "evaluate") (param i32 i32 i32 i32) (result i32) (drop (memory.grow (i32.const 1))) (i32.const 0)))`,
    );
    try {
      expect(() =>
        instantiateValueModule(
          contract,
          new Uint8Array(growing.emitBinary()),
        ).evaluate(validInput),
      ).toThrow("invalid value Wasm memory or start");
    } finally {
      growing.dispose();
    }
    const starting = binaryen.parseText(
      `(module (memory (export "memory") 16 16) (func $start) (start $start) (func (export "evaluate") (param i32 i32 i32 i32) (result i32) (i32.const 0)))`,
    );
    try {
      expect(() =>
        instantiateValueModule(contract, new Uint8Array(starting.emitBinary())),
      ).toThrow("invalid value Wasm memory or start");
    } finally {
      starting.dispose();
    }
  });

  test("version-2 bundle verifies without source or compiler", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-value-bundle-"));
    try {
      const out = join(root, "bundle");
      await buildValueModuleProgram({
        entry: "application/quote.ts",
        root: "examples/module-order-line",
        entryName: "quote",
        target: "all",
        outDir: out,
      });
      const manifest = JSON.parse(
        await readFile(join(out, "module-build.json"), "utf8"),
      );
      expect(manifest.version).toBe(2);
      const report = await verifyValueModuleBundle(
        join(out, "module-build.json"),
        "examples/module-order-line/suite.json",
      );
      expect(report.ok).toBe(true);
      manifest.resources.fuel = 1;
      await writeFile(join(out, "module-build.json"), JSON.stringify(manifest));
      await expect(
        verifyValueModuleBundle(
          join(out, "module-build.json"),
          "examples/module-order-line/suite.json",
        ),
      ).rejects.toThrow("invalid value manifest");
      manifest.resources.fuel = 100000;
      manifest.wasm.contract.outputLimit = 1;
      await writeFile(join(out, "module-build.json"), JSON.stringify(manifest));
      await expect(
        verifyValueModuleBundle(
          join(out, "module-build.json"),
          "examples/module-order-line/suite.json",
        ),
      ).rejects.toThrow("invalid value ABI contract");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("portable verification terminates an unbounded Wasm bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-value-timeout-"));
    try {
      const out = join(root, "bundle"),
        manifest = await buildValueModuleProgram({
          entry: "application/quote.ts",
          root: "examples/module-order-line",
          entryName: "quote",
          target: "wasm",
          outDir: out,
        }),
        looping = binaryen.parseText(
          `(module (memory (export "memory") 16 16) (func (export "evaluate") (param i32 i32 i32 i32) (result i32) (loop $forever (br $forever)) (i32.const 0)))`,
        );
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(looping.emitBinary());
      } finally {
        looping.dispose();
      }
      await writeFile(join(out, "wasm/program.wasm"), bytes);
      const artifact = manifest.artifacts.find(
        (item) => item.path === "wasm/program.wasm",
      );
      if (!artifact || !manifest.wasm) throw new Error("missing Wasm fixture");
      artifact.bytes = bytes.length;
      artifact.hash = digest(bytes);
      manifest.wasm.wasmHash = artifact.hash;
      await writeFile(join(out, "module-build.json"), JSON.stringify(manifest));
      await expect(
        verifyValueModuleBundle(
          join(out, "module-build.json"),
          "examples/module-order-line/suite.json",
        ),
      ).rejects.toThrow("execution timed out");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("checker rejects recursive types, shadowing and non-exhaustive matches", async () => {
    const recursive = moduleSource(
      { kind: "literal", type: "i32", value: 1 },
      "i32",
      [{ name: "node", type: { ref: "Node" } }],
      [
        {
          name: "Node",
          export: false,
          kind: "record",
          fields: [{ name: "next", type: { ref: "Node" } }],
        },
      ],
    );
    await fixture(recursive, async (root) => {
      await expect(
        loadValueModuleProgram("main.llang.jsonc", root, "evaluate"),
      ).rejects.toThrow("recursive type");
    });
    const recursiveCall = moduleSource({
      kind: "call",
      callee: "evaluate",
      arguments: [{ kind: "param", name: "input" }],
    });
    await fixture(recursiveCall, async (root) => {
      await expect(
        loadValueModuleProgram("main.llang.jsonc", root, "evaluate"),
      ).rejects.toThrow("recursive call");
    });

    await fixture(
      moduleSource(
        {
          kind: "field",
          base: paramField("choice"),
          name: "value",
        },
        "i32",
        [{ name: "choice", type: { ref: "Choice" } }],
        [
          {
            name: "Choice",
            export: false,
            kind: "union",
            variants: [
              { tag: "left", fields: [{ name: "value", type: "i32" }] },
              { tag: "right", fields: [{ name: "value", type: "i32" }] },
            ],
          },
        ],
      ),
      async (root) => {
        await expect(
          loadValueModuleProgram("main.llang.jsonc", root, "evaluate"),
        ).rejects.toThrow("field base must be a record");
      },
    );

    await fixture(
      moduleSource(
        { kind: "literal", type: "string", value: "\ud800" },
        "string",
      ),
      async (root) => {
        await expect(
          loadValueModuleProgram("main.llang.jsonc", root, "evaluate"),
        ).rejects.toThrow("Unicode surrogate");
      },
    );
    const shadow = moduleSource({
      kind: "block",
      bindings: [
        {
          name: "input",
          type: "i32",
          value: { kind: "literal", type: "i32", value: 1 },
        },
      ],
      result: { kind: "local", name: "input" },
    });
    await fixture(shadow, async (root) => {
      await expect(
        loadValueModuleProgram("main.llang.jsonc", root, "evaluate"),
      ).rejects.toThrow("shadowing");
    });
    const choices = [
      {
        name: "Choice",
        export: false,
        kind: "union",
        variants: [
          { tag: "a", fields: [{ name: "n", type: "i32" }] },
          { tag: "b", fields: [{ name: "n", type: "i32" }] },
        ],
      },
    ];
    const incomplete = moduleSource(
      {
        kind: "match",
        value: paramField("choice"),
        cases: [{ tag: "a", body: { kind: "local", name: "n" } }],
      },
      "i32",
      [{ name: "choice", type: { ref: "Choice" } }],
      choices,
    );
    await fixture(incomplete, async (root) => {
      await expect(
        loadValueModuleProgram("main.llang.jsonc", root, "evaluate"),
      ).rejects.toThrow("not exhaustive");
    });
  });
});
