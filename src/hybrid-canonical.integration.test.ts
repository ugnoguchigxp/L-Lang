import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { canonicalTypeHash } from "./canonical-type-ir";
import { importTypeScriptPredicate } from "./typescript-predicate-importer";
import { digest } from "./wasm-contract";
import { contractFromType } from "./wasm-core";
import { emitWasm } from "./wasm-emitter";

const repo = resolve(import.meta.dir, "..");
const sourcePath = resolve(repo, "examples/hybrid-order/can-ship.ts");
const baseline = {
  canShip: {
    semanticHash:
      "e92e379d4b51cab9e551b945f74fe381f2e539396ef03dc8aeebcac0403d8e69",
    wasmHash:
      "b9d6849e6d5d91beab447ba6d318c0ee531cdd450b6701b28bef4a6cfbb5c582",
  },
  needsManualReview: {
    semanticHash:
      "d50530d67a204c5ff30f99f7d8261db8a9ec04cc518dc20682fca6f33c8ba6f3",
    wasmHash:
      "31e35f6157e4f5b7255f95a90784fb6fe5525d2af4aced75727d364389dabe4b",
  },
} as const;

describe("Canonical Type backend migration", () => {
  for (const functionName of ["canShip", "needsManualReview"] as const) {
    test(`${functionName} preserves the H1 contract, semantic hash, and Wasm bytes`, async () => {
      const imported = await importTypeScriptPredicate({
        workspaceRoot: repo,
        sourcePath,
        functionName,
      });
      const legacyContract = contractFromType(imported.input.schema);
      const legacyBytes = emitWasm(imported.body, legacyContract);
      const canonicalBytes = emitWasm(imported.body, imported.contract);
      expect(imported.contract).toEqual(legacyContract);
      expect(canonicalBytes).toEqual(legacyBytes);
      expect(imported.semanticHash).toBe(baseline[functionName].semanticHash);
      expect(digest(canonicalBytes)).toBe(baseline[functionName].wasmHash);
      expect(imported.input.mapping).toEqual({
        provider: "typescript",
        status: "lossless",
        diagnostics: [],
      });
      expect(imported.input.canonicalTypeHash).toBe(
        canonicalTypeHash(imported.input.canonicalType),
      );
      expect(imported.projections.jsonSchema.status).toBe(
        "requires-host-adapter",
      );
      expect(imported.projections.specification.status).toBe(
        "implementation-description",
      );
    });
  }
});
