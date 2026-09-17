import { readArtifact } from "./wasm-artifact";
import type { WasmContract } from "./wasm-contract";
import { contractSlots, digest, encodeInput, WasmError } from "./wasm-contract";

export async function loadWasmPredicate(
  manifestPath: string,
  expectedManifestHash?: string,
) {
  const { manifest, bytes } = await readArtifact(manifestPath);
  if (
    expectedManifestHash !== undefined &&
    digest(JSON.stringify(manifest)) !== expectedManifestHash
  )
    throw new WasmError(
      "ARTIFACT_MISMATCH",
      "manifest changed after validation",
    );
  return instantiateWasmPredicate(manifest, bytes);
}

export async function instantiateWasmPredicate(
  manifest: {
    export: string;
    contract: WasmContract;
    wasmHash: string;
  },
  bytes: Uint8Array,
) {
  if (digest(bytes) !== manifest.wasmHash)
    throw new WasmError(
      "ARTIFACT_MISMATCH",
      "Wasm digest differs from manifest",
    );
  assertStatelessWasmBinary(bytes);
  const module = await WebAssembly.compile(bytes);
  const bindings = WebAssembly.Module.customSections(module, "llang.contract");
  if (
    bindings.length !== 1 ||
    new TextDecoder().decode(bindings[0]) !==
      digest(JSON.stringify(manifest.contract))
  )
    throw new WasmError(
      "ARTIFACT_MISMATCH",
      "ABI contract does not match Wasm",
    );
  const exports = WebAssembly.Module.exports(module);
  if (
    WebAssembly.Module.imports(module).length ||
    exports.length !== 1 ||
    exports[0]?.name !== manifest.export ||
    exports[0]?.kind !== "function"
  ) {
    throw new WasmError(
      "INVALID_ARTIFACT",
      "unexpected import/export contract",
    );
  }
  const instance = await WebAssembly.instantiate(module, {});
  const fn = instance.exports[manifest.export];
  if (
    typeof fn !== "function" ||
    fn.length !== contractSlots(manifest.contract).length
  )
    throw new WasmError("INVALID_ARTIFACT", "invalid evaluate signature");
  return {
    evaluate(input: unknown): boolean {
      const result: unknown = fn(...encodeInput(manifest.contract, input));
      if (result !== 0 && result !== 1)
        throw new WasmError("INVALID_ARTIFACT", "expected boolean result");
      return result === 1;
    },
  };
}

export function assertStatelessWasmBinary(bytes: Uint8Array): void {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d ||
    bytes[4] !== 0x01 ||
    bytes[5] !== 0x00 ||
    bytes[6] !== 0x00 ||
    bytes[7] !== 0x00
  ) {
    throw new WasmError("INVALID_ARTIFACT", "invalid Wasm header");
  }
  const forbiddenSections = new Set([4, 5, 6, 8, 9, 11, 12]);
  let offset = 8;
  while (offset < bytes.length) {
    const section = bytes[offset];
    if (section === undefined || section > 12) {
      throw new WasmError("INVALID_ARTIFACT", "invalid Wasm section");
    }
    offset += 1;
    const size = readVarUint32(bytes, offset);
    offset = size.next;
    if (forbiddenSections.has(section)) {
      throw new WasmError(
        "INVALID_ARTIFACT",
        "stateful Wasm sections are not allowed",
      );
    }
    offset += size.value;
    if (offset > bytes.length) {
      throw new WasmError("INVALID_ARTIFACT", "truncated Wasm section");
    }
  }
}

function readVarUint32(
  bytes: Uint8Array,
  start: number,
): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < bytes.length && shift <= 28; offset++) {
    const byte = bytes[offset];
    if (byte === undefined) break;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: offset + 1 };
    shift += 7;
  }
  throw new WasmError("INVALID_ARTIFACT", "invalid Wasm section size");
}
