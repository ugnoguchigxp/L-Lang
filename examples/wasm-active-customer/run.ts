import { loadWasmPredicate } from "../../src/wasm-runtime";

const path = process.argv[2];
if (!path)
  throw new Error(
    "usage: bun run examples/wasm-active-customer/run.ts <manifest.json>",
  );
const predicate = await loadWasmPredicate(path);
const results = [
  { status: "active", deletedAt: null, email: "" },
  { status: "suspended", deletedAt: null, email: "a@example.com" },
  { status: "active", deletedAt: null, email: undefined },
].map((input) => predicate.evaluate(input));
console.log(JSON.stringify(results));
