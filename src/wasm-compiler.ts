import { readSemanticResolution } from "./semantic-resolution-reader";
import { saveArtifact, type WasmManifest } from "./wasm-artifact";
import { digest } from "./wasm-contract";
import { contractFromType } from "./wasm-core";
import {
  emitWasm,
  WASM_BACKEND_VERSION,
  WASM_COMPILER_VERSION,
} from "./wasm-emitter";

export async function buildWasm(
  sourcePath: string,
  outputDirectory: string,
  workspaceRoot = process.cwd(),
  lockPath?: string,
) {
  const resolution = await readSemanticResolution(
    sourcePath,
    workspaceRoot,
    lockPath,
  );
  const contract = contractFromType(resolution.schema);
  const bytes = emitWasm(resolution.body, contract);
  const wasmHash = digest(bytes);
  const manifest: WasmManifest = {
    version: 1,
    profile: "predicate-i32-v1",
    export: "evaluate",
    contract,
    compiler: WASM_COMPILER_VERSION,
    backend: `binaryen@${WASM_BACKEND_VERSION}`,
    options: "mvp-no-optimization",
    irHash: digest(JSON.stringify(resolution.body)),
    provenance: resolution.provenance,
    wasmHash,
    file: `${wasmHash}.wasm`,
  };
  const path = await saveArtifact(outputDirectory, bytes, manifest);
  return { manifest: path, wasmHash, bytes: bytes.length, apiCalls: 0 };
}
