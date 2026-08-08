import { dirname, resolve } from "node:path";

import { verifyFrozenFileHashes } from "./schema-evolution-evaluator";
import { assertKnownKeys, readBoundedJsonFile } from "./semantic-limits";

const freezePath = resolve("benchmarks/schema-evolution/freeze.json");
const freeze = recordValue(
  await readBoundedJsonFile(freezePath, "protected benchmark freeze"),
  "protected benchmark freeze",
);
assertExactKeys(
  freeze,
  ["version", "status", "instructions", "files"],
  "protected benchmark freeze",
);
if (freeze.version !== 1) {
  throw new Error("protected benchmark freeze.version must be 1");
}
if (freeze.status !== "draft" && freeze.status !== "frozen") {
  throw new Error("protected benchmark freeze.status is invalid");
}
if (
  typeof freeze.instructions !== "string" ||
  freeze.instructions.length === 0
) {
  throw new Error("protected benchmark freeze.instructions is invalid");
}
if (
  typeof freeze.files !== "object" ||
  freeze.files === null ||
  Array.isArray(freeze.files) ||
  !Object.values(freeze.files).every((value) => typeof value === "string")
) {
  throw new Error("protected benchmark freeze file is malformed");
}
const files = freeze.files as Record<string, string>;
for (const [path, hash] of Object.entries(files)) {
  if (path.length === 0 || !/^[a-f0-9]{64}$/u.test(hash)) {
    throw new Error(`protected benchmark freeze entry is malformed: ${path}`);
  }
}
await verifyFrozenFileHashes(dirname(freezePath), files);
console.log("protected benchmark inputs verified");

function recordValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  assertKnownKeys(value, keys, path);
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) throw new Error(`${path} is missing ${missing}`);
}
