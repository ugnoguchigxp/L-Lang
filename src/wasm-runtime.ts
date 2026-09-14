import { readArtifact } from "./wasm-artifact";
import { contractSlots, digest, encodeInput, WasmError } from "./wasm-contract";

export async function loadWasmPredicate(manifestPath: string) {
  const { manifest, bytes } = await readArtifact(manifestPath);
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
