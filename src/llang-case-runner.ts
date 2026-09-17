import type { LlangSuite } from "./llang-capability-contracts";
import { WasmError } from "./wasm-contract";

function caseInput(item: LlangSuite["cases"][number]) {
  const input = { ...item.input };
  for (const key of item.undefinedFields)
    Object.defineProperty(input, key, { value: undefined, enumerable: true });
  return input;
}

export function executeCases(
  suite: LlangSuite,
  evaluate: (input: unknown) => boolean,
) {
  return suite.cases.map((item) => {
    let actual:
      | { kind: "value"; value: boolean }
      | { kind: "error"; code: string };
    try {
      actual = { kind: "value", value: evaluate(caseInput(item)) };
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
}
