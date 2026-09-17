import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveContainedFile } from "./contained-path";
import { readBounded } from "./wasm-artifact";
import {
  digest,
  parseContract,
  record,
  type WasmContract,
  WasmError,
} from "./wasm-contract";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { assertStatelessWasmBinary } from "./wasm-runtime";

export type LlangBuildManifest = {
  version: 2;
  language: "l-lang";
  profile: "predicate-i32-v1";
  export: "evaluate";
  contract: WasmContract;
  compiler: string;
  backend: string;
  options: "mvp-no-optimization";
  irHash: string;
  programHash: string;
  sourceHash: string;
  wasmHash: string;
  file: string;
};

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new WasmError("INVALID_ARTIFACT", `invalid ${label}`);
  return value;
}

export function parseLlangBuildManifest(input: unknown): LlangBuildManifest {
  const value = record(input, [
    "version",
    "language",
    "profile",
    "export",
    "contract",
    "compiler",
    "backend",
    "options",
    "irHash",
    "programHash",
    "sourceHash",
    "wasmHash",
    "file",
  ]);
  if (
    value.version !== 2 ||
    value.language !== "l-lang" ||
    value.profile !== "predicate-i32-v1" ||
    value.export !== "evaluate" ||
    value.options !== "mvp-no-optimization" ||
    typeof value.compiler !== "string" ||
    !value.compiler ||
    typeof value.backend !== "string" ||
    !value.backend
  )
    throw new WasmError("INVALID_ARTIFACT", "unsupported L-Lang manifest");
  const wasmHash = hash(value.wasmHash, "wasmHash");
  if (value.file !== `${wasmHash}.wasm`)
    throw new WasmError("INVALID_ARTIFACT", "invalid Wasm file name");
  return {
    version: 2,
    language: "l-lang",
    profile: "predicate-i32-v1",
    export: "evaluate",
    contract: parseContract(value.contract),
    compiler: value.compiler,
    backend: value.backend,
    options: "mvp-no-optimization",
    irHash: hash(value.irHash, "irHash"),
    programHash: hash(value.programHash, "programHash"),
    sourceHash: hash(value.sourceHash, "sourceHash"),
    wasmHash,
    file: String(value.file),
  };
}

export async function readLlangArtifact(manifestPath: string) {
  const absolute = resolve(manifestPath);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink())
    throw new WasmError(
      "INVALID_ARTIFACT",
      "manifest must be a regular non-symlink file",
    );
  const manifestBytes = await readBounded(absolute);
  const manifest = parseLlangBuildManifest(
    parseStrictJsonObject(decodeUtf8(manifestBytes, absolute), absolute),
  );
  const wasmPath = await resolveContainedFile(
    dirname(absolute),
    manifest.file,
    "L-Lang Wasm artifact",
    { rejectSymbolicLinks: true },
  );
  const bytes = await readBounded(wasmPath);
  const artifact = validateLlangArtifact(manifest, bytes);
  if (digest(await readBounded(absolute)) !== digest(manifestBytes))
    throw new WasmError("ARTIFACT_MISMATCH", "manifest changed while reading");
  return artifact;
}

export function validateLlangArtifact(
  manifestInput: unknown,
  bytes: Uint8Array,
) {
  const manifest = parseLlangBuildManifest(manifestInput);
  if (digest(bytes) !== manifest.wasmHash || !WebAssembly.validate(bytes))
    throw new WasmError("ARTIFACT_MISMATCH", "invalid L-Lang Wasm artifact");
  assertStatelessWasmBinary(bytes);
  const wasmBytes = new Uint8Array(bytes.byteLength);
  wasmBytes.set(bytes);
  const module = new WebAssembly.Module(wasmBytes.buffer);
  const exports = WebAssembly.Module.exports(module);
  if (
    WebAssembly.Module.imports(module).length ||
    exports.length !== 1 ||
    exports[0]?.name !== manifest.export ||
    exports[0]?.kind !== "function"
  )
    throw new WasmError(
      "INVALID_ARTIFACT",
      "unexpected import/export contract",
    );
  const contracts = WebAssembly.Module.customSections(module, "llang.contract");
  if (
    contracts.length !== 1 ||
    new TextDecoder().decode(contracts[0]) !==
      digest(JSON.stringify(manifest.contract))
  )
    throw new WasmError(
      "ARTIFACT_MISMATCH",
      "ABI contract does not match Wasm",
    );
  return { manifest, bytes };
}
