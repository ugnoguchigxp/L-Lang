import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { atomicWriteFile, atomicWriteJson } from "./atomic-file";
import { fingerprintFor } from "./stable-hash";
import {
  WASM_BACKEND_VERSION,
  WASM_COMPILER_VERSION,
  WASM_EXPORT,
  emitWasm,
} from "./wasm-emitter";
import { digest, WasmError } from "./wasm-contract";
import { decodeUtf8 } from "./llang-jsonc";
import { LLANG_SOURCE_BYTES } from "./llang-jsonc";
import { checkLlangProgram } from "./llang-program";
import { parseLlangBuildManifest } from "./llang-artifact";
export {
  parseLlangBuildManifest,
  readLlangArtifact,
  validateLlangArtifact,
  type LlangBuildManifest,
} from "./llang-artifact";

async function readRegularSource(path: string) {
  const absolute = resolve(path);
  if (!absolute.endsWith(".llang.jsonc"))
    throw new WasmError("INVALID_SOURCE", "source must use .llang.jsonc");
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink())
    throw new WasmError("INVALID_SOURCE", "source must be a regular file");
  if (info.size > LLANG_SOURCE_BYTES)
    throw new WasmError("INVALID_SOURCE", "source exceeds size limit");
  const bytes = await readFile(absolute);
  return { absolute, bytes, text: decodeUtf8(bytes, absolute) };
}

export async function buildLlangProgram(
  sourcePath: string,
  outputDirectory: string,
) {
  const captured = await readRegularSource(sourcePath);
  const result = checkLlangProgram(captured.text, captured.absolute);
  if (!result.checked)
    throw new WasmError(
      "INVALID_SOURCE",
      result.report.diagnostics
        .map((item) => `${item.code} ${item.path || "/"}: ${item.message}`)
        .join("; "),
    );
  const checked = result.checked;
  const bytes = emitWasm(checked.program.body, checked.program.contract);
  const wasmHash = digest(bytes);
  const manifest = parseLlangBuildManifest({
    version: 2,
    language: "l-lang",
    profile: checked.program.profile,
    export: WASM_EXPORT,
    contract: checked.program.contract,
    compiler: WASM_COMPILER_VERSION,
    backend: `binaryen@${WASM_BACKEND_VERSION}`,
    options: "mvp-no-optimization",
    irHash: fingerprintFor(checked.program.body),
    programHash: checked.programHash,
    sourceHash: checked.sourceHash,
    wasmHash,
    file: `${wasmHash}.wasm`,
  });
  const current = await readRegularSource(captured.absolute);
  if (digest(current.bytes) !== checked.sourceHash)
    throw new WasmError("SOURCE_CONFLICT", "source changed during build");
  const directory = resolve(outputDirectory);
  await atomicWriteFile(resolve(directory, manifest.file), bytes);
  const manifestPath = resolve(directory, "manifest.json");
  await atomicWriteJson(manifestPath, manifest);
  return {
    manifest: manifestPath,
    source: basename(captured.absolute),
    sourceHash: manifest.sourceHash,
    programHash: manifest.programHash,
    wasmHash,
    bytes: bytes.length,
    apiCalls: 0,
  };
}
