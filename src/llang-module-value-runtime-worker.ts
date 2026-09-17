import { instantiateValueModule } from "./llang-module-value-runtime";
import type { ValueWasmContract } from "./llang-module-value-wasm";
import type {
  ValueExpected,
  ValueModuleSuite,
} from "./llang-module-value-suite";

type Payload = {
  wasm: string;
  contract: ValueWasmContract;
  cases: ValueModuleSuite["cases"];
};

function canonical(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return JSON.stringify(value);
}
function matchesError(expected: ValueExpected, code: string): boolean {
  return expected.kind === "invalid-input"
    ? code === "INVALID_INPUT"
    : expected.kind === "fault"
      ? code === expected.code
      : false;
}

const payload = JSON.parse(
    await new Response(Bun.stdin.stream()).text(),
  ) as Payload,
  bytes = new Uint8Array(Buffer.from(payload.wasm, "base64")),
  runtime = instantiateValueModule(payload.contract, bytes),
  results = payload.cases.map((test) => {
    try {
      const actual = runtime.evaluate(test.input),
        pass =
          test.expected.kind === "value" &&
          canonical(actual) === canonical(test.expected.value);
      return {
        id: test.id,
        status: pass ? "pass" : "fail",
        expected: test.expected,
        actual,
      };
    } catch (error) {
      const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "EXECUTION_ERROR",
        pass = matchesError(test.expected, code);
      return {
        id: test.id,
        status: pass ? "pass" : "fail",
        expected: test.expected,
        error: error instanceof Error ? error.message : String(error),
        code,
      };
    }
  });

console.log(JSON.stringify(results));
