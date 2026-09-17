import { describe, expect, test } from "bun:test";

import { runHybridWasmScenarios } from "./run";
import { HYBRID_WASM_SCENARIOS } from "./scenarios";

describe("progressive Hybrid TypeScript to Wasm scenarios", () => {
  test("builds, verifies, rebuilds, and executes every difficulty level", async () => {
    const results = await runHybridWasmScenarios();

    expect(results).toHaveLength(7);
    expect(results.map(({ level }) => level)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(
      results.reduce((total, result) => total + result.cases.length, 0),
    ).toBe(30);
    for (const result of results) {
      expect(result.artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.semanticHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.wasmHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.portableVerification).toBe("passed");
      expect(result.rebuildVerification).toBe("passed");
      expect(result.cases.every(({ status }) => status === "passed")).toBe(
        true,
      );
    }
  });

  test("keeps scenario metadata ordered and uniquely addressable", () => {
    expect(new Set(HYBRID_WASM_SCENARIOS.map(({ id }) => id)).size).toBe(7);
    expect(HYBRID_WASM_SCENARIOS.map(({ level }) => level)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  test("runs one selected scenario", async () => {
    const [result] = await runHybridWasmScenarios("06-business-rule");
    expect(result).toMatchObject({
      id: "06-business-rule",
      portableVerification: "passed",
      rebuildVerification: "passed",
    });
    expect(result?.cases).toHaveLength(6);
  });

  test("rejects an unknown scenario before creating an artifact", async () => {
    await expect(runHybridWasmScenarios("unknown")).rejects.toThrow(
      "unknown scenario",
    );
  });
});
