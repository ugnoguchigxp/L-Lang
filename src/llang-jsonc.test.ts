import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { buildLlangProgram, readLlangArtifact } from "./llang-build";
import { runLlangCli } from "./llang-cli";
import {
  decodeUtf8,
  formatLlangJsonc,
  LLANG_SOURCE_BYTES,
  parseLlangJsonc,
  parseStrictJsonObject,
} from "./llang-jsonc";
import { checkLlangProgram } from "./llang-program";
import { instantiateWasmPredicate } from "./wasm-runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const valid = `{
  "language": "l-lang",
  "version": 1,
  "id": "enabled-user",
  "profile": "predicate-i32-v1",
  "description": "Enabled user predicate",
  "contract": {
    "version": 1,
    "fields": [
      {
        "name": "enabled",
        "kind": "boolean",
        "values": [],
        "nullable": false,
        "undefinable": false,
        "optional": false,
      },
      {
        "name": "status",
        "kind": "enum",
        "values": ["active", "suspended"],
        "nullable": false,
        "undefinable": false,
        "optional": false,
      },
    ],
  },
  "body": {
    "kind": "all",
    "conditions": [
      // Comments are part of the authored source.
      { "kind": "equals", "property": ["enabled"], "value": true },
      { "kind": "equals", "property": ["status"], "value": "active" },
    ],
  },
}
`;

describe("L-Lang JSONC parser and linter", () => {
  test("accepts comments and trailing commas and returns stable hashes", () => {
    const first = checkLlangProgram(valid, "program.llang.jsonc");
    const second = checkLlangProgram(valid, "program.llang.jsonc");
    expect(first.report).toEqual({
      version: 1,
      ok: true,
      diagnostics: [],
      truncated: false,
    });
    expect(first.checked?.sourceHash).toBe(second.checked?.sourceHash);
    expect(first.checked?.programHash).toBe(second.checked?.programHash);
  });

  test("published schema accepts the same valid program structure", async () => {
    const schema = JSON.parse(
      await readFile(
        resolve(import.meta.dir, "../schemas/llang-program-v1.schema.json"),
        "utf8",
      ),
    );
    const parsed = parseLlangJsonc(valid);
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(parsed.document).toBeDefined();
    expect(validate(parsed.document?.value)).toBe(true);
    expect(validate.errors).toBeNull();
    const structuralVariants = [
      {
        kind: "any",
        conditions: [{ kind: "equals", property: ["enabled"], value: true }],
      },
      {
        kind: "not",
        condition: { kind: "equals", property: ["enabled"], value: false },
      },
      { kind: "present", property: ["status"] },
      { kind: "equals", property: ["status"], value: null },
    ];
    for (const body of structuralVariants) {
      const variant = structuredClone(parsed.document?.value) as {
        body: unknown;
      };
      variant.body = body;
      expect(validate(variant), JSON.stringify(body)).toBe(true);
    }
    const numeric = structuredClone(parsed.document?.value) as {
      body: { conditions: { property: string[]; value: unknown }[] };
    };
    const firstCondition = numeric.body.conditions[0];
    if (!firstCondition) throw new Error("fixture body is empty");
    firstCondition.value = 1;
    expect(validate(numeric)).toBe(false);
    firstCondition.value = true;
    firstCondition.property = ["enabled", "nested"];
    expect(validate(numeric)).toBe(false);
    const unknownExpression = structuredClone(parsed.document?.value) as {
      body: Record<string, unknown>;
    };
    unknownExpression.body.extra = true;
    expect(validate(unknownExpression)).toBe(false);
    const empty = structuredClone(parsed.document?.value) as {
      body: { conditions: unknown[] };
    };
    empty.body.conditions = [];
    expect(validate(empty)).toBe(false);
  });

  test("rejects duplicate decoded keys with both locations", () => {
    const result = parseLlangJsonc('{"body": 1, "b\\u006fdy": 2}', "x.jsonc");
    expect(result.report.ok).toBe(false);
    const duplicate = result.report.diagnostics.find(
      (item) => item.code === "LLJ002",
    );
    expect(duplicate?.path).toBe("/body");
    expect(duplicate?.related).toHaveLength(1);
    expect(duplicate?.range.start.column).toBeGreaterThan(1);
  });

  test("strict supporting JSON rejects duplicate keys and JSONC extensions", () => {
    expect(() => parseStrictJsonObject('{"id": 1, "id": 2}')).toThrow("LLJ002");
    expect(() => parseStrictJsonObject('{"id": 1,}')).toThrow("standard JSON");
    expect(() => parseStrictJsonObject('{// comment\n"id": 1}')).toThrow(
      "standard JSON",
    );
  });

  test("rejects JSON5 syntax and incomplete JSONC", () => {
    for (const source of ["{unquoted: 1}", "{'single': 1}", '{"x": [1}']) {
      const result = parseLlangJsonc(source);
      expect(result.report.ok).toBe(false);
      expect(result.report.diagnostics[0]?.code).toBe("LLJ001");
    }
  });

  test("rejects BOM, excessive depth, non-finite numbers and surrogates", () => {
    const sources = [
      `\ufeff${valid}`,
      `${"[".repeat(65)}0${"]".repeat(65)}`,
      '{"value": 1e9999}',
      '{"value": "\\ud800"}',
    ];
    for (const source of sources) {
      const result = parseLlangJsonc(source);
      expect(result.report.ok).toBe(false);
      expect(result.report.diagnostics.length).toBeGreaterThan(0);
    }
  });

  test("enforces the exact byte limit and rejects invalid UTF-8", () => {
    const atLimit = `{/*${"x".repeat(LLANG_SOURCE_BYTES - 7)}*/}\n`;
    expect(Buffer.byteLength(atLimit)).toBe(LLANG_SOURCE_BYTES);
    expect(parseLlangJsonc(atLimit).report.ok).toBe(true);
    const overLimit = atLimit.replace("*/}", "x*/}");
    expect(Buffer.byteLength(overLimit)).toBe(LLANG_SOURCE_BYTES + 1);
    expect(parseLlangJsonc(overLimit).report.diagnostics).toMatchObject([
      { code: "LLJ003" },
    ]);
    expect(() =>
      decodeUtf8(new Uint8Array([0xc3, 0x28]), "invalid.llang.jsonc"),
    ).toThrow("valid UTF-8");
  });

  test("reports CRLF and astral text locations in UTF-16 columns", () => {
    const result = parseLlangJsonc(
      '{\r\n  "emoji😀": 1, "emoji\\ud83d\\ude00": 2\r\n}',
      "position.llang.jsonc",
    );
    const duplicate = result.report.diagnostics.find(
      (item) => item.code === "LLJ002",
    );
    expect(duplicate?.range.start).toMatchObject({ line: 2, column: 17 });
    expect(duplicate?.related[0]?.range.start).toMatchObject({
      line: 2,
      column: 3,
    });
  });

  test("reports schema and semantic errors at useful paths", () => {
    const typo = valid
      .replace('"description": "Enabled user predicate",', '"extra": true,')
      .replace('"value": "active"', '"value": "actve"');
    const result = checkLlangProgram(typo, "program.llang.jsonc");
    expect(result.report.ok).toBe(false);
    expect(
      result.report.diagnostics.map((item) => [item.code, item.path]),
    ).toContainEqual(["LLS001", "/extra"]);
    const literal = result.report.diagnostics.find(
      (item) => item.code === "LLT001",
    );
    expect(literal?.path).toBe("/body/conditions/1/value");
    expect(literal?.hint).toContain('"active"');
    expect(literal?.range.start.line).toBeGreaterThan(1);
  });

  test("bounds diagnostics while marking the report as truncated", () => {
    const extras = Array.from(
      { length: 80 },
      (_, index) => `"extra${index}": true,`,
    ).join("\n");
    const result = checkLlangProgram(valid.replace("{\n", `{\n${extras}\n`));
    expect(result.report.diagnostics).toHaveLength(32);
    expect(result.report.truncated).toBe(true);
  });

  test("reports duplicate conditions as warnings with an opt-in failing exit", async () => {
    const duplicate = valid.replace(
      '{ "kind": "equals", "property": ["status"], "value": "active" }',
      '{ "kind": "equals", "property": ["enabled"], "value": true }',
    );
    const checked = checkLlangProgram(duplicate);
    expect(checked.report.ok).toBe(true);
    expect(checked.report.diagnostics).toMatchObject([
      { code: "LLW001", severity: "warning", related: [{}] },
    ]);
    const root = await mkdtemp(resolve(tmpdir(), "llang-warning-"));
    roots.push(root);
    const path = resolve(root, "program.llang.jsonc");
    await writeFile(path, duplicate);
    expect((await runLlangCli(["lint", path])).exitCode).toBe(0);
    expect(
      (await runLlangCli(["lint", path, "--warnings-as-errors"])).exitCode,
    ).toBe(1);
  });

  test("format is idempotent and preserves comments and program meaning", () => {
    const messy = valid.replaceAll("  ", "    ").replace("{\n", "{   \n");
    const once = formatLlangJsonc(messy).text;
    const twice = formatLlangJsonc(once).text;
    expect(once).toBe(twice);
    expect(once).toContain("// Comments are part of the authored source.");
    expect(checkLlangProgram(once).checked?.programHash).toBe(
      checkLlangProgram(valid).checked?.programHash,
    );
  });

  test("format preserves block comments, string markers and trailing commas", () => {
    const source = `{
/* before */ "url":"https://example.test//literal",
"items":[1,/* between */2,],
}`;
    const formatted = formatLlangJsonc(source).text;
    expect(formatted).toContain("/* before */");
    expect(formatted).toContain("/* between */");
    expect(formatted).toContain('"https://example.test//literal"');
    expect(formatted).toMatch(/2,\s*\]/);
    expect(formatted).toMatch(/\],\s*\}/);
    expect(formatLlangJsonc(formatted).text).toBe(formatted);
  });

  test("format refuses invalid input without changing the file", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "llang-invalid-format-"));
    roots.push(root);
    const path = resolve(root, "invalid.llang.jsonc");
    const source = '{"id": 1, "id": 2}\n';
    await writeFile(path, source);
    expect((await runLlangCli(["format", path, "--write"])).exitCode).toBe(1);
    expect(await readFile(path, "utf8")).toBe(source);
  });

  test("CLI lint and format use deterministic exit codes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "llang-jsonc-"));
    roots.push(root);
    const path = resolve(root, "program.llang.jsonc");
    await writeFile(path, valid.replace("{\n", "{  \n"));
    const lint = await runLlangCli(["lint", path, "--json"]);
    expect(lint.exitCode).toBe(0);
    expect(lint.output).toMatchObject({ ok: true });
    expect((await runLlangCli(["format", path, "--check"])).exitCode).toBe(1);
    expect((await runLlangCli(["format", path, "--write"])).exitCode).toBe(0);
    expect((await runLlangCli(["format", path, "--check"])).exitCode).toBe(0);
    expect(await readFile(path, "utf8")).toContain(
      "// Comments are part of the authored source.",
    );
  });

  test("builds a v2 artifact directly and executes without an API call", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "llang-build-"));
    roots.push(root);
    const path = resolve(root, "program.llang.jsonc");
    await writeFile(path, valid);
    const built = await buildLlangProgram(path, resolve(root, "out"));
    expect(built.apiCalls).toBe(0);
    const artifact = await readLlangArtifact(built.manifest);
    expect(artifact.manifest.version).toBe(2);
    expect(artifact.manifest.programHash).toBe(built.programHash);
    const predicate = await instantiateWasmPredicate(
      artifact.manifest,
      artifact.bytes,
    );
    expect(predicate.evaluate({ enabled: true, status: "active" })).toBe(true);
    expect(predicate.evaluate({ enabled: false, status: "active" })).toBe(
      false,
    );
    const cli = await runLlangCli([
      "build",
      path,
      "--out-dir",
      resolve(root, "cli-out"),
    ]);
    expect(cli.exitCode).toBe(0);
    expect(cli.output).toMatchObject({ wasmHash: built.wasmHash, apiCalls: 0 });
  });

  test("comments change sourceHash but not programHash or Wasm", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "llang-hash-"));
    roots.push(root);
    const firstPath = resolve(root, "first.llang.jsonc");
    const secondPath = resolve(root, "second.llang.jsonc");
    await writeFile(firstPath, valid);
    await writeFile(
      secondPath,
      valid.replace(
        "// Comments are part of the authored source.",
        "// A different implementation note.",
      ),
    );
    const first = await buildLlangProgram(firstPath, resolve(root, "first"));
    const second = await buildLlangProgram(secondPath, resolve(root, "second"));
    expect(first.sourceHash).not.toBe(second.sourceHash);
    expect(first.programHash).toBe(second.programHash);
    expect(first.wasmHash).toBe(second.wasmHash);
  });

  test("artifact reader rejects modified Wasm and unknown manifest fields", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "llang-tamper-"));
    roots.push(root);
    const path = resolve(root, "program.llang.jsonc");
    const output = resolve(root, "out");
    await writeFile(path, valid);
    const built = await buildLlangProgram(path, output);
    const manifest = JSON.parse(await readFile(built.manifest, "utf8"));
    const wasmPath = resolve(output, manifest.file);
    const bytes = new Uint8Array(await readFile(wasmPath));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await writeFile(wasmPath, bytes);
    await expect(readLlangArtifact(built.manifest)).rejects.toThrow(
      "invalid L-Lang Wasm artifact",
    );
    await writeFile(
      built.manifest,
      JSON.stringify({ ...manifest, unexpected: true }),
    );
    await expect(readLlangArtifact(built.manifest)).rejects.toThrow(
      "unknown key",
    );
  });
});
