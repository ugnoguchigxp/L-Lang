import { performance } from "node:perf_hooks";
import type { Customer } from "../examples/active-customer/semantic";

const [mode, manifest] = process.argv.slice(2);
if ((mode !== "ts" && mode !== "wasm") || !manifest) {
  throw new Error(
    "usage: bun run src/wasm-runtime-benchmark.ts <ts|wasm> <manifest>",
  );
}
const begin = performance.now();
const evaluate =
  mode === "wasm"
    ? (await (await import("./wasm-runtime")).loadWasmPredicate(manifest))
        .evaluate
    : (await import("../examples/active-customer/is-active-customer.generated"))
        .isActiveCustomer;
const loadMs = performance.now() - begin;
const inputs: Customer[] = [
  { status: "active", deletedAt: null, email: "" },
  { status: "suspended", deletedAt: null, email: "x" },
  { status: "active", deletedAt: "2026-01-01", email: "x" },
  { status: "active", deletedAt: null, email: undefined },
];
let checksum = 0;
for (let i = 0; i < 100000; i++) {
  const input = inputs[i % inputs.length];
  if (input) checksum += Number(evaluate(input));
}
console.log(
  JSON.stringify({
    mode,
    loadMs,
    rssBytes: process.memoryUsage().rss,
    checksum,
  }),
);
