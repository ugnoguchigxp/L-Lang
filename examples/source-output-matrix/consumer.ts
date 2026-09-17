import { readBounded } from "../../src/wasm-artifact";
import { decodeUtf8, parseStrictJsonObject } from "../../src/llang-jsonc";
// This file is bundled and copied with each release. It never imports a compiler.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  digest,
  encodeInput,
  parseContract,
  record,
} from "../../src/wasm-contract";
import { instantiateWasmPredicate } from "../../src/wasm-runtime";
import { validateLlangArtifact } from "../../src/llang-artifact";

export async function loadRelease(directory: string) {
  const path = resolve(directory, "release.json");
  const manifest = record(
    parseStrictJsonObject(decodeUtf8(await readBounded(path), path), path),
    [
      "version",
      "sourceKind",
      "target",
      "sourceHash",
      "contract",
      "artifactHash",
      "build",
    ],
  );
  const contract = parseContract(manifest.contract);
  if (
    manifest.version !== 1 ||
    !["typescript", "wasm"].includes(String(manifest.target))
  )
    throw new Error("unsupported example release");
  const filename =
    manifest.target === "typescript"
      ? "predicate.generated.ts"
      : "predicate.wasm";
  const bytes = await readBounded(resolve(directory, filename));
  if (digest(bytes) !== manifest.artifactHash)
    throw new Error("artifact hash mismatch");
  if (manifest.target === "wasm") {
    const artifact = validateLlangArtifact(manifest.build, bytes);
    if (JSON.stringify(artifact.manifest.contract) !== JSON.stringify(contract))
      throw new Error("contract mismatch");
    return (await instantiateWasmPredicate(artifact.manifest, bytes)).evaluate;
  }
  // Only load locally built/trusted TypeScript: hashes detect corruption, not malicious publishers.
  const module = await import(pathToFileURL(resolve(directory, filename)).href);
  return (input: unknown): boolean => {
    encodeInput(contract, input);
    const value: unknown = module.evaluate(input);
    if (typeof value !== "boolean") throw new Error("invalid predicate result");
    return value;
  };
}

if (import.meta.main) {
  try {
    const evaluate = await loadRelease(import.meta.dir);
    console.log(
      JSON.stringify({ value: evaluate(JSON.parse(process.argv[2] ?? "{}")) }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 2;
  }
}
