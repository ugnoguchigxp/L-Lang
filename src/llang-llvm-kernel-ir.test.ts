import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import {
  assertLlvmKernelPlan,
  extractLlvmKernelPlan,
} from "./llang-llvm-kernel-ir";

describe("LLVM experiment kernel projection", () => {
  test("TypeScript and JSONC sources produce the same bound plan", async () => {
    const [jsonProgram, tsProgram] = await Promise.all([
        loadCollectionModuleProgram(
          "application/evaluate.llang.jsonc",
          "examples/llvm-sum-i32",
          "evaluate",
        ),
        loadCollectionModuleProgram(
          "application/evaluate.ts",
          "examples/llvm-sum-i32",
          "evaluate",
        ),
      ]),
      jsonPlan = extractLlvmKernelPlan(jsonProgram),
      tsPlan = extractLlvmKernelPlan(tsProgram),
      schema = JSON.parse(
        await readFile("schemas/llvm-kernel-plan-v1.schema.json", "utf8"),
      ),
      validate = new Ajv2020({ strict: true }).compile(schema);
    expect(jsonProgram.programHash).toBe(tsProgram.programHash);
    expect(jsonProgram.loweredHash).toBe(tsProgram.loweredHash);
    expect(jsonPlan).toEqual(tsPlan);
    expect(jsonPlan.sourceProgramHash).toBe(jsonProgram.programHash);
    expect(jsonPlan.sourceLoweredHash).toBe(jsonProgram.loweredHash);
    expect(validate(jsonPlan)).toBe(true);
    expect(assertLlvmKernelPlan(jsonPlan)).toEqual(jsonPlan);
  });

  test("rejects every near-match instead of generalizing the subset", async () => {
    const program = await loadCollectionModuleProgram(
        "application/evaluate.llang.jsonc",
        "examples/llvm-sum-i32",
        "evaluate",
      ),
      mutations: Array<readonly [readonly (string | number)[], unknown]> = [
        [["functions", 0, "parameterTypes", 0, "fields", 0, "name"], "items"],
        [["functions", 0, "returnType", "fields", 0, "name"], "sum"],
        [
          [
            "functions",
            0,
            "body",
            "statements",
            0,
            "value",
            "arguments",
            1,
            "value",
          ],
          1,
        ],
        [
          [
            "functions",
            0,
            "body",
            "statements",
            0,
            "value",
            "arguments",
            2,
            "body",
            "result",
            "op",
          ],
          "-",
        ],
        [
          [
            "functions",
            0,
            "body",
            "statements",
            0,
            "value",
            "arguments",
            2,
            "parameters",
            0,
            "type",
          ],
          "string",
        ],
      ];
    for (const [path, replacement] of mutations) {
      const candidate = structuredClone(program);
      setAtPath(candidate, path, replacement);
      expect(() => extractLlvmKernelPlan(candidate)).toThrow(
        "UNSUPPORTED_LLVM_EXPERIMENT",
      );
    }
  });

  test("rejects unknown keys and a forged plan hash", async () => {
    const program = await loadCollectionModuleProgram(
        "application/evaluate.llang.jsonc",
        "examples/llvm-sum-i32",
        "evaluate",
      ),
      plan = extractLlvmKernelPlan(program);
    expect(() =>
      assertLlvmKernelPlan({ ...plan, hash: "0".repeat(64) }),
    ).toThrow("hash mismatch");
    expect(() => assertLlvmKernelPlan({ ...plan, extra: true })).toThrow(
      "INVALID_LLVM_KERNEL_PLAN",
    );
  });
});

function setAtPath(
  value: unknown,
  path: readonly (string | number)[],
  replacement: unknown,
): void {
  let current = value;
  for (const part of path.slice(0, -1)) {
    if (!current || typeof current !== "object" || !(part in current))
      throw new Error("invalid test mutation path");
    current = (current as Record<string | number, unknown>)[part];
  }
  const last = path.at(-1);
  if (
    last === undefined ||
    !current ||
    typeof current !== "object" ||
    !(last in current)
  )
    throw new Error("invalid test mutation path");
  (current as Record<string | number, unknown>)[last] = replacement;
}
