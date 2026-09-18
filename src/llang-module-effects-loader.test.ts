import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020";
import {
  checkEffectsModule,
  parseEffectsModuleJsonc,
  parseEffectsModuleTypeScript,
} from "./llang-module-effects-loader";

const definition = {
  module: "example/effects",
  operations: [
    {
      id: "host.increment",
      version: 1,
      requestType: { value: "i32" },
      responseType: { value: "i32" },
      errorType: { code: "string" },
      effect: "host",
      resource: "none",
      cancellable: true,
      idempotent: true,
    },
  ],
  initial: 1,
  steps: [
    {
      operation: "host.increment",
      version: 1,
      payload: 41,
      combine: "add",
    },
  ],
} as const;

describe("module-effects-v1 initial frontend", () => {
  test("published source schema accepts the implemented JSONC shape", async () => {
    const schema = JSON.parse(
        await readFile("schemas/llang-module-v5.schema.json", "utf8"),
      ),
      validate = new Ajv2020({ strict: true }).compile(schema);
    expect(
      validate({
        language: "l-lang",
        version: 5,
        kind: "module",
        profile: "module-effects-v1",
        entry: "main",
        ...definition,
      }),
    ).toBe(true);
  });

  test("JSONC and restricted TypeScript produce the same checked program", () => {
    const json = parseEffectsModuleJsonc(`{
        "language": "l-lang",
        "version": 5,
        "kind": "module",
        "profile": "module-effects-v1",
        "module": "example/effects",
        "entry": "main",
        "operations": ${JSON.stringify(definition.operations)},
        "initial": 1,
        "steps": ${JSON.stringify(definition.steps)},
      }`),
      typescript = parseEffectsModuleTypeScript(`
        import { defineEffects } from "llang:effects";
        export const main = defineEffects(${JSON.stringify(definition)});
      `),
      checkedJson = checkEffectsModule(
        json,
        "main.llang.jsonc",
        "a".repeat(64),
      ),
      checkedTs = checkEffectsModule(typescript, "main.ts", "b".repeat(64));
    expect(typescript).toEqual(json);
    expect(checkedTs.program).toEqual(checkedJson.program);
    expect(checkedTs.manifest).toEqual(checkedJson.manifest);
    expect(checkedTs.manifest.effects).toEqual(["host"]);
    expect(checkedTs.program.steps[0]?.operation).toBe(0);

    const firstStep = json.steps[0];
    if (!firstStep) throw new Error("missing test step");
    const repeated = checkEffectsModule(
      {
        ...json,
        steps: Object.freeze([firstStep, firstStep]),
      },
      "repeated.llang.jsonc",
      "d".repeat(64),
    );
    expect(repeated.manifest.operations).toHaveLength(1);
    expect(repeated.program.steps.map((item) => item.operation)).toEqual([
      0, 0,
    ]);
  });

  test("rejects dynamic TypeScript and undeclared operations", () => {
    expect(() =>
      parseEffectsModuleTypeScript(`
        import { defineEffects } from "llang:effects";
        const payload = 1;
        export const main = defineEffects({ ...payload });
      `),
    ).toThrow("invalid module-effects-v1 TypeScript shape");
    const parsed = parseEffectsModuleJsonc(`{
      "language":"l-lang","version":5,"kind":"module",
      "profile":"module-effects-v1","module":"bad","entry":"main",
      "operations":${JSON.stringify(definition.operations)},"initial":0,
      "steps":[{"operation":"host.missing","version":1,"payload":0,"combine":"replace"}]
    }`);
    expect(() =>
      checkEffectsModule(parsed, "bad.llang.jsonc", "c".repeat(64)),
    ).toThrow("UNKNOWN_OPERATION");
  });
});
