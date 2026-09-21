import { describe, expect, test } from "bun:test";
import binaryen from "binaryen";
import { emitDirectKernelWat, emitLlvmKernelIr } from "./llang-llvm-emitter";
import { extractLlvmKernelPlan } from "./llang-llvm-kernel-ir";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import {
  emitDirectKernelWasm,
  expectedLlvmKernelBoundaryStatus,
  LlvmKernelWasmHarness,
} from "./llang-llvm-wasm";

async function plan() {
  return extractLlvmKernelPlan(
    await loadCollectionModuleProgram(
      "application/evaluate.llang.jsonc",
      "examples/llvm-sum-i32",
      "evaluate",
    ),
  );
}

function compile(wat: string): Uint8Array {
  const module = binaryen.parseText(wat);
  try {
    if (!module.validate()) throw new Error("invalid mutant");
    return new Uint8Array(module.emitBinary());
  } finally {
    module.dispose();
  }
}

describe("LLVM kernel emitters", () => {
  test("emits deterministic checked IR without unproved attributes or paths", async () => {
    const value = await plan(),
      wasm = emitLlvmKernelIr(
        value,
        "wasm32",
        "wasm32-unknown-unknown",
        "e-m:e-p:32:32-i64:64-n32:64-S128",
      ),
      native = emitLlvmKernelIr(
        value,
        "native-arm64",
        "arm64-apple-macosx26.0.0",
        "e-m:o-i64:64-i128:128-n32:64-S128-Fn32",
      );
    expect(wasm).toBe(
      emitLlvmKernelIr(
        value,
        "wasm32",
        "wasm32-unknown-unknown",
        "e-m:e-p:32:32-i64:64-n32:64-S128",
      ),
    );
    expect(wasm).toContain("llvm.sadd.with.overflow.i32");
    expect(wasm).toContain("load i32, ptr %element, align 1");
    expect(wasm).toContain("store i32 %next.sum, ptr %out, align 1");
    expect(wasm).not.toMatch(
      /\b(?:nsw|nuw|inbounds|noalias|nonnull|dereferenceable)\b/,
    );
    expect(wasm).not.toContain(process.cwd());
    expect(wasm).not.toContain("/tmp/");
    expect(native).not.toContain("llvm.wasm.memory.size");
  });

  test("five independent mutants are detected by fixed semantic or boundary cases", async () => {
    const original = emitDirectKernelWat(await plan()),
      replacements: Array<{
        name: string;
        find: string;
        replace: string;
        detected: (harness: LlvmKernelWasmHarness) => boolean;
      }> = [
        {
          name: "checked-add removed",
          find: "i64.const -2147483648 i64.lt_s\n        local.get $sum i64.const 2147483647 i64.gt_s i32.or",
          replace: "i32.const 0",
          detected: (harness) => harness.invoke([2147483647, 1]).status !== 1,
        },
        {
          name: "loop starts at one",
          find: "block $done loop $loop\n        local.get $index",
          replace:
            "i32.const 1 local.set $index\n      block $done loop $loop\n        local.get $index",
          detected: (harness) => harness.invoke([5, 7]).value !== 12,
        },
        {
          name: "signed count guard",
          find: "local.get $count i32.const 4096 i32.gt_u",
          replace: "local.get $count i32.const 4096 i32.lt_s",
          detected: (harness) => harness.invoke([1]).status !== 0,
        },
        {
          name: "early output store",
          find: "local.get $count i32.const 4096 i32.gt_u\n      if i32.const 2 return end",
          replace:
            "local.get $count i32.const 4096 i32.gt_u\n      if local.get $out i32.const 0 i32.store i32.const 2 return end",
          detected: (harness) => {
            harness.view.setInt32(64, 123, true);
            harness.invokeRaw(64, 4097, 64);
            return harness.view.getInt32(64, true) !== 123;
          },
        },
        {
          name: "input order reversed",
          find: "local.get $values local.get $index i32.const 2 i32.shl i32.add\n        i32.load",
          replace:
            "local.get $values local.get $count i32.const 1 i32.sub local.get $index i32.sub i32.const 2 i32.shl i32.add\n        i32.load",
          detected: (harness) =>
            harness.invoke([2147483647, 1, -1]).status !== 1,
        },
      ];
    for (const mutation of replacements) {
      const mutated = original.replace(mutation.find, mutation.replace);
      expect(mutated, mutation.name).not.toBe(original);
      expect(
        mutation.detected(new LlvmKernelWasmHarness(compile(mutated))),
        mutation.name,
      ).toBe(true);
    }
  });

  test("derives boundary outcomes independently and preserves rejected ranges", async () => {
    expect(expectedLlvmKernelBoundaryStatus(65, 2, 65_537)).toBe(0);
    expect(expectedLlvmKernelBoundaryStatus(64, 2, 64)).toBe(2);
    expect(expectedLlvmKernelBoundaryStatus(64, 2, 71)).toBe(2);
    expect(expectedLlvmKernelBoundaryStatus(131_069, 1, 65_536)).toBe(2);
    expect(expectedLlvmKernelBoundaryStatus(64, 4097, 65_536)).toBe(2);

    const harness = new LlvmKernelWasmHarness(
      emitDirectKernelWasm(await plan()).bytes,
    );
    harness.view.setInt32(65_536, 0x5a5a5a5a, true);
    const result = harness.invokeRaw(64, 4097, 65_536);
    expect(result.status).toBe(2);
    expect(result.outputAfter).toBe(result.outputBefore);

    expect(
      () =>
        new LlvmKernelWasmHarness(
          compile(`(module
            (memory (export "memory") 2 2)
            (func (export "llang_checked_sum_i32")
              (param i32 i32) (result i32) i32.const 0))`),
        ),
    ).toThrow("invalid memory or signature");
  });
});
