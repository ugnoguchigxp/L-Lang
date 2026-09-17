import ts from "typescript";

import { readHybridArtifact } from "./hybrid-artifact";
import { canonicalHash, HybridArtifactError } from "./hybrid-artifact-values";
import { importIsolatedHybridPredicate } from "./hybrid-isolated-import";
import {
  emitWasm,
  WASM_BACKEND_VERSION,
  WASM_COMPILER_VERSION,
} from "./wasm-emitter";
import { sha256 } from "./stable-hash";

export async function rebuildVerifyImportedPredicateArtifact(
  manifestPath: string,
) {
  const artifact = await readHybridArtifact(manifestPath);
  if (
    artifact.typescriptProfile.typescriptVersion !== ts.version ||
    artifact.build.compiler !== WASM_COMPILER_VERSION ||
    artifact.build.backend !== `binaryen@${WASM_BACKEND_VERSION}` ||
    artifact.build.options !== "mvp-no-optimization"
  ) {
    throw new HybridArtifactError(
      "TOOLCHAIN_MISMATCH",
      "artifact toolchain differs from current toolchain",
    );
  }
  const imported = await importIsolatedHybridPredicate({
    source: artifact.source,
    functionName: artifact.resolution.source.functionName,
    profile: artifact.typescriptProfile,
  });
  const expected = {
    canonicalType: artifact.resolution.input.canonicalType,
    body: artifact.resolution.body,
    semanticHash: artifact.resolution.semanticHash,
    contract: artifact.build.contract,
    jsonSchema: JSON.parse(new TextDecoder().decode(artifact.jsonSchema)),
    specification: new TextDecoder().decode(artifact.specification),
  };
  const actual = {
    canonicalType: imported.input.canonicalType,
    body: imported.body,
    semanticHash: imported.semanticHash,
    contract: imported.contract,
    jsonSchema: imported.projections.jsonSchema,
    specification: imported.projections.specification.content,
  };
  const wasm = emitWasm(imported.body, imported.contract);
  if (
    canonicalHash(actual) !== canonicalHash(expected) ||
    sha256(wasm) !== artifact.build.wasmHash
  ) {
    throw new HybridArtifactError(
      "REBUILD_MISMATCH",
      "artifact cannot be reproduced by the current toolchain",
    );
  }
  return {
    version: 1 as const,
    mode: "rebuild" as const,
    status: "passed" as const,
    artifactHash: artifact.artifactHash,
    semanticHash: artifact.resolution.semanticHash,
    wasmHash: artifact.build.wasmHash,
    completedAt: new Date().toISOString(),
    apiCalls: 0 as const,
    temporaryWrites: true as const,
  };
}
