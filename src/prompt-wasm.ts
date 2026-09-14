import { basename } from "node:path";
import { RESOLUTION_PROTOCOL, readPromptResolution } from "./prompt-resolution";
import { contentHash, exampleInput } from "./prompt-source";
import { readArtifact, saveArtifact, type WasmManifest } from "./wasm-artifact";
import { digest, WasmError } from "./wasm-contract";

export async function buildPromptWasm(path: string, outputDirectory: string) {
  const { source, revision, lock } = await readPromptResolution(path);
  const { emitWasm, WASM_BACKEND_VERSION, WASM_COMPILER_VERSION } =
    await import("./wasm-emitter");
  const bytes = emitWasm(lock.body, source.contract);
  const wasmHash = digest(bytes);
  const manifest: WasmManifest = {
    version: 1,
    profile: source.profile,
    export: "evaluate",
    contract: source.contract,
    compiler: WASM_COMPILER_VERSION,
    backend: `binaryen@${WASM_BACKEND_VERSION}`,
    options: "mvp-no-optimization",
    irHash: digest(JSON.stringify(lock.body)),
    wasmHash,
    file: `${wasmHash}.wasm`,
    provenance: {
      source: basename(path),
      concept: source.id,
      predicate: source.id,
      fingerprint: lock.checksum,
      conceptHash: contentHash({
        intent: source.intent,
        requirements: source.requirements,
        unresolvedWhen: source.unresolvedWhen,
      }),
      sourceHash: revision,
      typeHash: contentHash(source.contract),
      testHash: contentHash(source.examples),
      promptHash: contentHash(RESOLUTION_PROTOCOL),
      contextVersion: 1,
      contextHash: contentHash({ profile: source.profile }),
    },
  };
  return {
    manifest: await saveArtifact(outputDirectory, bytes, manifest),
    wasmHash,
    bytes: bytes.length,
    apiCalls: 0,
  };
}
function assertLinked(
  resolution: Awaited<ReturnType<typeof readPromptResolution>>,
  manifest: WasmManifest,
) {
  const { source, revision, lock } = resolution;
  if (
    manifest.provenance.sourceHash !== revision ||
    manifest.provenance.fingerprint !== lock.checksum ||
    manifest.irHash !== digest(JSON.stringify(lock.body)) ||
    contentHash(manifest.contract) !== contentHash(source.contract)
  )
    throw new WasmError(
      "ARTIFACT_MISMATCH",
      "artifact is not linked to the current source and lock",
    );
}
export async function inspectPrompt(path: string, manifestPath?: string) {
  const resolution = await readPromptResolution(path);
  const { source, revision, lock } = resolution;
  if (manifestPath)
    assertLinked(resolution, (await readArtifact(manifestPath)).manifest);
  return {
    id: source.id,
    revision,
    lockHash: lock.checksum,
    profile: source.profile,
    requirements: source.requirements,
    body: lock.body,
    resolver: lock.resolver,
    examples: source.examples.length,
    diagnostics: lock.diagnostics,
    apiCalls: 0,
  };
}
export async function testPromptWasm(path: string, manifestPath: string) {
  const resolution = await readPromptResolution(path);
  const { source, revision, lock } = resolution;
  const { manifest } = await readArtifact(manifestPath);
  assertLinked(resolution, manifest);
  const { loadWasmPredicate } = await import("./wasm-runtime");
  const runtime = await loadWasmPredicate(
    manifestPath,
    digest(JSON.stringify(manifest)),
  );
  const results = source.examples.map((e) => ({
    id: e.id,
    expected: e.expected,
    actual: runtime.evaluate(exampleInput(e)),
  }));
  if (results.some((r) => r.expected !== r.actual))
    throw new WasmError(
      "EXAMPLE_MISMATCH",
      "Wasm does not satisfy source examples",
    );
  return {
    revision,
    lockHash: lock.checksum,
    wasmHash: manifest.wasmHash,
    passed: results.length,
    results,
    apiCalls: 0,
  };
}
