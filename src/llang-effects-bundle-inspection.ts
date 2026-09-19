import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { atomicWriteText } from "./atomic-file";
import { effectValueTypeJson } from "./llang-effects-ir";
import { emitTypedEffectsWasm } from "./llang-effects-state-machine";
import type { LoweredEffectState } from "./llang-effects-state-machine";
import { assertEffectsWasm } from "./llang-effects-wasm";
import { decodeUtf8 } from "./llang-jsonc";
import {
  type EffectsModuleBuildManifest,
  emitEffectsGraphTypeScript,
  readEffectsModuleBuildManifest,
  verifyEffectsGeneratedTypeScript,
} from "./llang-module-effects-build";
import {
  checkFlattenedEffectsGraph,
  parseEffectsGraphJsonc,
} from "./llang-module-effects-graph";
import { fingerprintFor } from "./stable-hash";
import { digest, WasmError } from "./wasm-contract";

export const LLANG_EFFECTS_BUNDLE_INSPECTION_VERSION = 1 as const;
export const LLANG_EFFECTS_PROJECTION_VERSION = 1 as const;

export type EffectsBundleSnapshot = Awaited<
  ReturnType<typeof readEffectsModuleBuildManifest>
>;
export type TypedEffectsWasm = NonNullable<
  EffectsModuleBuildManifest["wasm"]
> & {
  contract: NonNullable<EffectsModuleBuildManifest["wasm"]>["contract"] & {
    layout: "typed-wire-v1";
  };
  states: NonNullable<
    NonNullable<EffectsModuleBuildManifest["wasm"]>["states"]
  >;
};
type DirectoryIdentity = { dev: number; ino: number };
type InspectionWriter = (path: string, value: string) => Promise<void>;

const artifact = (
  snapshot: EffectsBundleSnapshot,
  path: string,
): Uint8Array => {
  const bytes = snapshot.artifacts.get(path);
  if (!bytes)
    throw new WasmError(
      "INVALID_ARTIFACT",
      `effects inspection requires ${path}`,
    );
  return bytes;
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const bundleIdentity = (manifest: EffectsModuleBuildManifest): string =>
  fingerprintFor({
    manifest,
    artifacts: manifest.artifacts.map(({ path, hash, bytes }) => ({
      path,
      hash,
      bytes,
    })),
  });

function requireInspectionTargets(
  manifest: EffectsModuleBuildManifest,
): TypedEffectsWasm {
  if (manifest.targets.join() !== "typescript,jsonc,wasm")
    throw new WasmError(
      "INVALID_ARTIFACT",
      "effects inspection requires a module-effects-v1 bundle built with --target all",
    );
  if (
    !manifest.wasm ||
    !("layout" in manifest.wasm.contract) ||
    manifest.wasm.contract.layout !== "typed-wire-v1" ||
    !manifest.wasm.states
  )
    throw new WasmError(
      "INVALID_ARTIFACT",
      "effects inspection requires a typed-wire-v1 graph bundle",
    );
  return manifest.wasm as TypedEffectsWasm;
}

function reportFor(snapshot: EffectsBundleSnapshot) {
  const { manifest } = snapshot,
    wasm = requireInspectionTargets(manifest),
    jsoncBytes = artifact(snapshot, "jsonc/program.llang.jsonc"),
    bundledTypeScriptBytes = artifact(
      snapshot,
      "typescript/program.generated.ts",
    ),
    bundledWasm = artifact(snapshot, "wasm/program.wasm"),
    jsonc = decodeUtf8(jsoncBytes, "jsonc/program.llang.jsonc"),
    bundledTypeScript = decodeUtf8(
      bundledTypeScriptBytes,
      "typescript/program.generated.ts",
    ),
    graph = checkFlattenedEffectsGraph(
      parseEffectsGraphJsonc(jsonc, "jsonc/program.llang.jsonc"),
      digest(jsoncBytes),
    ),
    projection = emitEffectsGraphTypeScript(graph),
    emitted = emitTypedEffectsWasm(graph.program, graph.manifest.operations),
    regeneratedStates = emitted.states.map((state) => ({
      kind: state.kind,
      operation: state.operation,
      requestType: effectValueTypeJson(state.requestType),
      responseType: effectValueTypeJson(state.responseType),
    }));

  const operationAt = (index: number) => {
      const operation = manifest.operations[index];
      if (!operation)
        throw new WasmError(
          "INVALID_ARTIFACT",
          "effects state refers to an unknown operation",
        );
      return operation;
    },
    operationFor = (id: string, version: number) => {
      const operation = manifest.operations.find(
        (candidate) => candidate.id === id && candidate.version === version,
      );
      if (!operation)
        throw new WasmError(
          "INVALID_ARTIFACT",
          "effects task refers to an unknown operation",
        );
      return operation;
    };

  verifyEffectsGeneratedTypeScript(projection);
  assertEffectsWasm(emitted.bytes);
  if (
    graph.entry !== manifest.entry ||
    graph.interfaceHash !== manifest.interfaceHash
  )
    throw new WasmError(
      "INVALID_ARTIFACT",
      "flattened JSONC entry or interface does not match the effects manifest",
    );
  if (
    fingerprintFor(graph.manifest.operations) !==
      fingerprintFor(manifest.operations) ||
    fingerprintFor(graph.manifest.effects) !== fingerprintFor(manifest.effects)
  )
    throw new WasmError(
      "INVALID_ARTIFACT",
      "flattened JSONC operations do not match the effects manifest",
    );
  if (
    projection !== bundledTypeScript ||
    digest(projection) !==
      manifest.artifacts.find(
        (item) => item.path === "typescript/program.generated.ts",
      )?.hash
  )
    throw new WasmError(
      "INVALID_ARTIFACT",
      "regenerated TypeScript does not match the bundled artifact",
    );
  if (
    !equalBytes(emitted.bytes, bundledWasm) ||
    digest(emitted.bytes) !== wasm.wasmHash ||
    emitted.contract.programHash !== manifest.loweredHash
  )
    throw new WasmError(
      "INVALID_ARTIFACT",
      "regenerated Wasm does not match the bundled artifact",
    );
  if (
    fingerprintFor(emitted.contract) !== fingerprintFor(wasm.contract) ||
    fingerprintFor(regeneratedStates) !== fingerprintFor(wasm.states)
  )
    throw new WasmError(
      "INVALID_ARTIFACT",
      "regenerated Wasm contract or states do not match the manifest",
    );

  return {
    format: "llang-effects-bundle-inspection" as const,
    version: LLANG_EFFECTS_BUNDLE_INSPECTION_VERSION,
    profile: manifest.profile,
    abi: manifest.abi,
    entry: manifest.entry,
    bundleIdentityHash: bundleIdentity(manifest),
    sourceTracking: {
      sourceSetHash: manifest.sourceSetHash,
      sources: manifest.sources,
      sourceBodies: "not-in-bundle" as const,
      sourceVerification: "not-run" as const,
    },
    semantics: {
      programHash: manifest.programHash,
      flattenedProgramHash: graph.programHash,
      loweredHash: manifest.loweredHash,
      interfaceHash: manifest.interfaceHash,
      resultType: manifest.resultType,
    },
    authority: {
      declaredEffects: manifest.effects,
      requiredOperations: manifest.operations,
      runtimeGrant: "not-provided" as const,
      meaning:
        "Declared effects and operation requirements do not grant runtime authority.",
    },
    continuationStates: wasm.states.map((state, index) => ({
      index,
      kind: state.kind,
      ...(state.kind === "task"
        ? {
            internal: "task.join" as const,
            requiresHostGrant: false as const,
            taskOperations:
              graph.program.nodes[index]?.kind === "task"
                ? graph.program.nodes[index].tasks.map((task) => ({
                    operation: operationFor(task.operation, task.version),
                    requiresHostGrant: true as const,
                  }))
                : (() => {
                    throw new WasmError(
                      "INVALID_ARTIFACT",
                      "effects task state does not match the reconstructed graph",
                    );
                  })(),
          }
        : {
            operation: operationAt(state.operation),
            requiresHostGrant: true as const,
          }),
      requestType: state.requestType,
      responseType: state.responseType,
    })),
    resources: manifest.resources,
    artifacts: {
      sourceSetHash: manifest.sourceSetHash,
      programHash: manifest.programHash,
      loweredHash: manifest.loweredHash,
      interfaceHash: manifest.interfaceHash,
      files: manifest.artifacts,
      wasm: manifest.wasm,
      toolchain: manifest.toolchain,
    },
    reconstruction: {
      flattenedJsonc: "checked" as const,
      interface: "checked" as const,
      operations: "checked" as const,
      typescriptBytes: "checked" as const,
      typescriptTypecheck: "checked" as const,
      wasmBytes: "checked" as const,
      wasmContract: "checked" as const,
      wasmStates: "checked" as const,
    },
    typescript: {
      projectionVersion: LLANG_EFFECTS_PROJECTION_VERSION,
      source: projection,
      projectionHash: digest(projection),
      artifactHash: digest(bundledTypeScriptBytes),
    },
    inspection: {
      integrity: "checked-by-regeneration" as const,
      execution: "not-run" as const,
      runtimeGrant: "not-provided" as const,
      transcript: "not-provided" as const,
      credentials: "not-accessed" as const,
      apiCalls: 0 as const,
      authenticity:
        "Compare bundleIdentityHash with an externally trusted value; internal consistency does not establish publisher authenticity.",
      semanticScope:
        "Regeneration checks this fixed compiler path; it is not a general proof of semantic equivalence.",
      runtimeScope:
        "Host adapters, runtime grants, credentials, deadlines, resource-ledger behavior, and actual effects were not inspected or executed.",
    },
  };
}

export type VerifiedEffectsExecutionSnapshot = Readonly<{
  manifestPath: string;
  manifest: EffectsModuleBuildManifest;
  graph: ReturnType<typeof checkFlattenedEffectsGraph>;
  wasmBytes: Uint8Array;
  states: readonly LoweredEffectState[];
  bundleIdentityHash: string;
  inspection: ReturnType<typeof reportFor>;
}>;

export async function readVerifiedEffectsExecutionSnapshot(
  path: string,
): Promise<VerifiedEffectsExecutionSnapshot> {
  const manifestPath = resolve(path),
    snapshot = await readEffectsModuleBuildManifest(manifestPath),
    inspection = reportFor(snapshot),
    jsoncBytes = artifact(snapshot, "jsonc/program.llang.jsonc"),
    graph = checkFlattenedEffectsGraph(
      parseEffectsGraphJsonc(
        decodeUtf8(jsoncBytes, "jsonc/program.llang.jsonc"),
        "jsonc/program.llang.jsonc",
      ),
      digest(jsoncBytes),
    ),
    emitted = emitTypedEffectsWasm(graph.program, graph.manifest.operations);
  return Object.freeze({
    manifestPath,
    manifest: snapshot.manifest,
    graph,
    wasmBytes: artifact(snapshot, "wasm/program.wasm").slice(),
    states: emitted.states,
    bundleIdentityHash: inspection.bundleIdentityHash,
    inspection,
  });
}

function isContained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (!relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      relation !== ".." &&
      !isAbsolute(relation))
  );
}

async function assertExternalNewDirectory(
  manifestPath: string,
  outputDirectory: string,
): Promise<string> {
  const directory = resolve(outputDirectory),
    bundleRoot = await realpath(dirname(resolve(manifestPath)));
  if ((await lstat(dirname(directory))).isSymbolicLink())
    throw new WasmError(
      "INVALID_ARGUMENT",
      "effects inspection output parent must not be a symbolic link",
    );
  const parent = await realpath(dirname(directory)),
    canonicalTarget = resolve(parent, basename(directory));
  if (isContained(bundleRoot, canonicalTarget))
    throw new WasmError(
      "INVALID_ARGUMENT",
      "effects inspection output must be outside the bundle",
    );
  return canonicalTarget;
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new WasmError(
      "INVALID_ARGUMENT",
      "effects inspection output changed during publication",
    );
  return { dev: info.dev, ino: info.ino };
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await directoryIdentity(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino)
    throw new WasmError(
      "INVALID_ARGUMENT",
      "effects inspection output changed during publication",
    );
}

async function assertPublishedText(path: string, expected: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new WasmError(
      "INVALID_ARGUMENT",
      "effects inspection output changed during publication",
    );
  const actual = await readFile(path),
    expectedBytes = new TextEncoder().encode(expected);
  if (!equalBytes(actual, expectedBytes))
    throw new WasmError(
      "INVALID_ARGUMENT",
      "effects inspection output changed during publication",
    );
}

async function sameDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
): Promise<boolean> {
  try {
    const current = await directoryIdentity(path);
    return current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

async function atomicCreateText(path: string, value: string): Promise<void> {
  const pending = resolve(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.pending`,
  );
  try {
    await atomicWriteText(pending, value);
    await link(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

async function assertUnchanged(path: string, expectedIdentity: string) {
  const current = await readEffectsModuleBuildManifest(path);
  if (bundleIdentity(current.manifest) !== expectedIdentity)
    throw new WasmError(
      "INVALID_ARTIFACT",
      "effects bundle changed during inspection",
    );
}

export async function assertEffectsBundleIdentity(
  path: string,
  expectedIdentity: string,
): Promise<void> {
  await assertUnchanged(path, expectedIdentity);
}

export async function inspectEffectsModuleBundle(
  path: string,
  outputDirectory?: string,
  write: InspectionWriter = atomicCreateText,
) {
  const snapshot = await readEffectsModuleBuildManifest(path),
    report = reportFor(snapshot),
    identityHash = report.bundleIdentityHash;
  if (!outputDirectory) {
    await assertUnchanged(path, identityHash);
    return report;
  }

  const directory = await assertExternalNewDirectory(path, outputDirectory);
  await mkdir(directory);
  const identity = await directoryIdentity(directory),
    projectionPath = resolve(directory, "program.inspection.ts"),
    reportPath = resolve(directory, "effects-inspection.json"),
    reportText = `${JSON.stringify(report, null, 2)}\n`;
  try {
    await assertDirectoryIdentity(directory, identity);
    await write(projectionPath, report.typescript.source);
    await assertDirectoryIdentity(directory, identity);
    await assertPublishedText(projectionPath, report.typescript.source);
    await assertUnchanged(path, identityHash);
    await assertDirectoryIdentity(directory, identity);
    await write(reportPath, reportText);
    await assertDirectoryIdentity(directory, identity);
    await assertPublishedText(projectionPath, report.typescript.source);
    await assertPublishedText(reportPath, reportText);
    await assertUnchanged(path, identityHash);
    await assertDirectoryIdentity(directory, identity);
    await assertPublishedText(projectionPath, report.typescript.source);
    await assertPublishedText(reportPath, reportText);
    return report;
  } catch (error) {
    if (await sameDirectoryIdentity(directory, identity))
      await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
