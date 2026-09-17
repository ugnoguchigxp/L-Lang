import type { LlangBuildManifest } from "./llang-build";
import type { LlangSuite } from "./llang-capability";
import { WasmError } from "./wasm-contract";
import { instantiateWasmPredicate } from "./wasm-runtime";

declare const self: Worker;

self.onmessage = async (
  event: MessageEvent<{
    build: LlangBuildManifest;
    bytes: Uint8Array;
    suite: LlangSuite;
  }>,
) => {
  try {
    const predicate = await instantiateWasmPredicate(
      event.data.build,
      event.data.bytes,
    );
    const results = event.data.suite.cases.map((item) => {
      const input = { ...item.input };
      for (const key of item.undefinedFields)
        Object.defineProperty(input, key, {
          value: undefined,
          enumerable: true,
        });
      let actual:
        | { kind: "value"; value: boolean }
        | { kind: "error"; code: string };
      try {
        actual = { kind: "value", value: predicate.evaluate(input) };
      } catch (error) {
        actual = {
          kind: "error",
          code: error instanceof WasmError ? error.code : "EXECUTION_ERROR",
        };
      }
      const status =
        actual.kind === "error" && actual.code !== "INVALID_INPUT"
          ? "error"
          : JSON.stringify(actual) === JSON.stringify(item.expected)
            ? "pass"
            : "fail";
      return {
        id: item.id,
        requirementIds: item.requirementIds,
        expected: item.expected,
        actual,
        status,
      };
    });
    self.postMessage({ results });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
