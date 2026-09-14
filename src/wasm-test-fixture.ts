import type { PredicateExpression } from "./ir";
import type { TypeSchema } from "./semantic-source";
import type { WasmManifest } from "./wasm-artifact";
import { digest } from "./wasm-contract";
import { contractFromType } from "./wasm-core";
import {
  emitWasm,
  WASM_BACKEND_VERSION,
  WASM_COMPILER_VERSION,
} from "./wasm-emitter";

export const customerSchema: TypeSchema = {
  kind: "object",
  properties: [
    {
      name: "status",
      optional: false,
      type: {
        kind: "union",
        types: [
          { kind: "literal", value: "active" },
          { kind: "literal", value: "suspended" },
        ],
      },
    },
    {
      name: "deletedAt",
      optional: false,
      type: { kind: "union", types: [{ kind: "string" }, { kind: "null" }] },
    },
    {
      name: "email",
      optional: false,
      type: {
        kind: "union",
        types: [{ kind: "string" }, { kind: "null" }, { kind: "undefined" }],
      },
    },
  ],
};
export const customerBody: PredicateExpression = {
  kind: "all",
  conditions: [
    { kind: "equals", property: ["status"], value: "active" },
    { kind: "equals", property: ["deletedAt"], value: null },
    { kind: "present", property: ["email"] },
  ],
};
export function fixtureArtifact(
  body: PredicateExpression = customerBody,
  schema: TypeSchema = customerSchema,
) {
  const contract = contractFromType(schema);
  const bytes = emitWasm(body, contract);
  const hash = digest(bytes);
  const provenance = {
    source: "fixture.ts",
    concept: "fixture",
    predicate: "evaluate",
    fingerprint: digest("fixture"),
    conceptHash: digest("concept"),
    sourceHash: digest("source"),
    typeHash: digest("type"),
    testHash: digest("test"),
    promptHash: digest("prompt"),
    contextHash: digest("context"),
    contextVersion: 1,
  };
  const manifest: WasmManifest = {
    version: 1,
    profile: "predicate-i32-v1",
    export: "evaluate",
    contract,
    compiler: WASM_COMPILER_VERSION,
    backend: `binaryen@${WASM_BACKEND_VERSION}`,
    options: "mvp-no-optimization",
    irHash: digest(JSON.stringify(body)),
    provenance,
    wasmHash: hash,
    file: `${hash}.wasm`,
  };
  return { bytes, manifest };
}
