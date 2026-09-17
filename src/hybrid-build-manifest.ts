import {
  canonicalHash,
  dataRecord,
  exactKeys,
  hash,
  invalid,
  strictJsonValue,
} from "./hybrid-artifact-values";
import type { HybridImportResolution } from "./hybrid-import-resolution";
import { canonicalTypeHash } from "./canonical-type-ir";
import { fingerprintFor } from "./stable-hash";
import { contractFromCanonicalType } from "./wasm-core";
import { parseContract, type WasmContract } from "./wasm-contract";

export type HybridBuildManifest = {
  version: 1;
  profile: "predicate-i32-v1";
  export: "evaluate";
  resolutionHash: string;
  canonicalTypeHash: string;
  semanticHash: string;
  contract: WasmContract;
  contractHash: string;
  compiler: string;
  backend: string;
  options: "mvp-no-optimization";
  wasmHash: string;
  file: string;
};

export function parseHybridBuildManifest(
  input: unknown,
  resolution?: HybridImportResolution,
): HybridBuildManifest {
  const root = dataRecord(input, "build", [
    "version",
    "profile",
    "export",
    "resolutionHash",
    "canonicalTypeHash",
    "semanticHash",
    "contract",
    "contractHash",
    "compiler",
    "backend",
    "options",
    "wasmHash",
    "file",
  ]);
  exactKeys(root, "build", [
    "version",
    "profile",
    "export",
    "resolutionHash",
    "canonicalTypeHash",
    "semanticHash",
    "contract",
    "contractHash",
    "compiler",
    "backend",
    "options",
    "wasmHash",
    "file",
  ]);
  if (
    root.version !== 1 ||
    root.profile !== "predicate-i32-v1" ||
    root.export !== "evaluate" ||
    root.options !== "mvp-no-optimization" ||
    typeof root.compiler !== "string" ||
    root.compiler.length === 0 ||
    root.compiler.length > 128 ||
    typeof root.backend !== "string" ||
    root.backend.length === 0 ||
    root.backend.length > 128
  ) {
    invalid("unsupported hybrid build manifest");
  }
  const contract = parseContract(
    strictJsonValue(root.contract, "build.contract"),
  );
  const result: HybridBuildManifest = {
    version: 1,
    profile: "predicate-i32-v1",
    export: "evaluate",
    resolutionHash: hash(root.resolutionHash, "build.resolutionHash"),
    canonicalTypeHash: hash(root.canonicalTypeHash, "build.canonicalTypeHash"),
    semanticHash: hash(root.semanticHash, "build.semanticHash"),
    contract,
    contractHash: hash(root.contractHash, "build.contractHash"),
    compiler: root.compiler,
    backend: root.backend,
    options: "mvp-no-optimization",
    wasmHash: hash(root.wasmHash, "build.wasmHash"),
    file: typeof root.file === "string" ? root.file : "",
  };
  if (result.file !== `${result.wasmHash}.wasm`)
    invalid("Wasm filename mismatch");
  if (result.contractHash !== fingerprintFor(contract))
    invalid("contract hash mismatch");
  if (resolution !== undefined) {
    const expectedContract = contractFromCanonicalType(
      resolution.input.canonicalType,
    );
    if (
      result.canonicalTypeHash !==
        canonicalTypeHash(resolution.input.canonicalType) ||
      result.semanticHash !== resolution.semanticHash ||
      result.contractHash !== fingerprintFor(expectedContract) ||
      canonicalHash(contract) !== canonicalHash(expectedContract)
    ) {
      invalid("resolution/build linkage mismatch");
    }
  }
  return result;
}

export function hybridBuildManifestHash(input: unknown): string {
  return canonicalHash(parseHybridBuildManifest(input));
}
