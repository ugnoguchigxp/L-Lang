import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { verifyFrozenFileHashes } from "./schema-evolution-evaluator";

const freezePath = resolve("benchmarks/schema-evolution/freeze.json");
const freeze = JSON.parse(await readFile(freezePath, "utf8")) as {
  files?: unknown;
};
if (
  typeof freeze.files !== "object" ||
  freeze.files === null ||
  Array.isArray(freeze.files) ||
  !Object.values(freeze.files).every((value) => typeof value === "string")
) {
  throw new Error("protected benchmark freeze file is malformed");
}
await verifyFrozenFileHashes(
  dirname(freezePath),
  freeze.files as Record<string, string>,
);
console.log("protected benchmark inputs verified");
