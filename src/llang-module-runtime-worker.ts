import { instantiateWasmPredicate } from "./wasm-runtime";
import type { WasmContract } from "./wasm-contract";

type Payload = {
  wasm: string;
  wasmHash: string;
  export: string;
  contract: WasmContract;
  cases: { id: string; input: unknown; expected: boolean | "INVALID_INPUT" }[];
};

const payload = JSON.parse(
  await new Response(Bun.stdin.stream()).text(),
) as Payload;
const bytes = new Uint8Array(Buffer.from(payload.wasm, "base64"));
const runtime = await instantiateWasmPredicate(
  {
    export: payload.export,
    contract: payload.contract,
    wasmHash: payload.wasmHash,
  },
  bytes,
);
const results = payload.cases.map((test) => {
  try {
    const actual = runtime.evaluate(test.input);
    return {
      id: test.id,
      status: actual === test.expected ? "pass" : "fail",
      expected: test.expected,
      actual,
    };
  } catch (error) {
    const invalid =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "INVALID_INPUT";
    return {
      id: test.id,
      status: invalid && test.expected === "INVALID_INPUT" ? "pass" : "fail",
      expected: test.expected,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
console.log(JSON.stringify(results));
