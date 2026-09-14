import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-file";
import { resolveContainedFile } from "./contained-path";
import {
  digest,
  parseContract,
  record,
  WASM_LIMITS,
  type WasmContract,
  WasmError,
} from "./wasm-contract";

export type WasmManifest = {
  version: 1;
  profile: "predicate-i32-v1";
  export: "evaluate";
  contract: WasmContract;
  compiler: string;
  backend: string;
  options: "mvp-no-optimization";
  irHash: string;
  provenance: Record<string, string | number>;
  wasmHash: string;
  file: string;
};

export function parseManifest(input: unknown): WasmManifest {
  const m = record(input, [
    "version",
    "profile",
    "export",
    "contract",
    "compiler",
    "backend",
    "options",
    "irHash",
    "provenance",
    "wasmHash",
    "file",
  ]);
  if (
    m.version !== 1 ||
    m.profile !== "predicate-i32-v1" ||
    m.export !== "evaluate" ||
    m.options !== "mvp-no-optimization" ||
    typeof m.compiler !== "string" ||
    !m.compiler ||
    typeof m.backend !== "string" ||
    !m.backend ||
    typeof m.irHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(m.irHash) ||
    typeof m.wasmHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(m.wasmHash) ||
    m.file !== `${m.wasmHash}.wasm`
  ) {
    throw new WasmError(
      "INVALID_ARTIFACT",
      "unsupported manifest or invalid hash",
    );
  }
  const p = record(m.provenance, [
    "source",
    "concept",
    "predicate",
    "fingerprint",
    "conceptHash",
    "sourceHash",
    "typeHash",
    "testHash",
    "promptHash",
    "contextVersion",
    "contextHash",
  ]);
  const provenance: Record<string, string | number> = {};
  for (const k of [
    "source",
    "concept",
    "predicate",
    "fingerprint",
    "conceptHash",
    "sourceHash",
    "typeHash",
    "testHash",
    "promptHash",
    "contextHash",
  ]) {
    const v = p[k];
    if (
      typeof v !== "string" ||
      !v ||
      v.length > 4096 ||
      ((k.endsWith("Hash") || k === "fingerprint") && !/^[a-f0-9]{64}$/.test(v))
    )
      throw new WasmError("INVALID_ARTIFACT", `invalid provenance ${k}`);
    provenance[k] = v;
  }
  if (p.contextVersion !== 1)
    throw new WasmError("INVALID_ARTIFACT", "invalid context version");
  provenance.contextVersion = 1;
  return {
    version: 1,
    profile: "predicate-i32-v1",
    export: "evaluate",
    contract: parseContract(m.contract),
    compiler: m.compiler,
    backend: m.backend,
    options: "mvp-no-optimization",
    irHash: m.irHash,
    provenance,
    wasmHash: m.wasmHash,
    file: String(m.file),
  };
}

export async function readBounded(path: string): Promise<Uint8Array> {
  if ((await stat(path)).size > WASM_LIMITS.bytes)
    throw new WasmError("INVALID_ARTIFACT", "file exceeds size limit");
  const bytes = await readFile(path);
  if (bytes.length > WASM_LIMITS.bytes)
    throw new WasmError("INVALID_ARTIFACT", "file exceeds size limit");
  return new Uint8Array(bytes);
}

export async function readArtifact(manifestPath: string) {
  const manifest = parseManifest(
    JSON.parse(new TextDecoder().decode(await readBounded(manifestPath))),
  );
  const path = await resolveContainedFile(
    dirname(manifestPath),
    manifest.file,
    "Wasm artifact",
    { rejectSymbolicLinks: true },
  );
  const bytes = await readBounded(path);
  if (digest(bytes) !== manifest.wasmHash)
    throw new WasmError(
      "ARTIFACT_MISMATCH",
      "Wasm digest differs from manifest",
    );
  return { manifest, bytes };
}

export async function saveArtifact(
  directory: string,
  bytes: Uint8Array,
  manifestInput: WasmManifest,
  write = atomicWriteFile,
): Promise<string> {
  const manifest = parseManifest(manifestInput);
  if (
    bytes.length > WASM_LIMITS.bytes ||
    digest(bytes) !== manifest.wasmHash ||
    !WebAssembly.validate(bytes)
  )
    throw new WasmError("ARTIFACT_MISMATCH", "invalid output Wasm");
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(text) > WASM_LIMITS.bytes)
    throw new WasmError("INVALID_ARTIFACT", "manifest exceeds size limit");
  await write(resolve(directory, manifest.file), bytes);
  const path = resolve(directory, "manifest.json");
  await write(path, text);
  return path;
}
