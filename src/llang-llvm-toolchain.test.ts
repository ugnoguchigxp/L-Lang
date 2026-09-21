import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLlvmToolchain, runTool } from "./llang-llvm-toolchain";
import { runNativeKernel } from "./llang-llvm-native-runner";

describe("LLVM experiment process boundaries", () => {
  test("an explicitly selected missing tool directory fails closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-no-llvm-"));
    try {
      expect(discoverLlvmToolchain(root, root)).rejects.toThrow(
        "TOOLCHAIN_UNAVAILABLE",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tool timeout and output limits are classified", async () => {
    expect(runTool("/bin/sleep", ["2"], { timeoutMs: 10 })).rejects.toThrow(
      "LLVM_TOOL_TIMEOUT",
    );
    expect(runTool("/usr/bin/yes", [], { outputBytes: 1024 })).rejects.toThrow(
      "LLVM_TOOL_OUTPUT_LIMIT",
    );
  });

  test("native child errors do not become successful returns", async () => {
    const result = await runNativeKernel(
      "/definitely/missing.dylib",
      [1],
      2_000,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toContain("no such file");
  });
});
