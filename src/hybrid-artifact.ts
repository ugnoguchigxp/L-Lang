import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { projectCanonicalTypeToJsonSchema } from "./canonical-type-json-schema";
import { resolveContainedFile } from "./contained-path";
import {
  parseHybridBuildManifest,
  type HybridBuildManifest,
} from "./hybrid-build-manifest";
import {
  canonicalHash,
  canonicalJson,
  dataRecord,
  exactKeys,
  hash,
  HybridArtifactError,
  identifier,
  invalid,
} from "./hybrid-artifact-values";
import {
  hybridImportResolutionHash,
  parseHybridImportResolution,
  type HybridImportResolution,
} from "./hybrid-import-resolution";
import {
  hybridTypeScriptProfileHash,
  parseHybridTypeScriptProfile,
  type HybridTypeScriptProfile,
} from "./hybrid-typescript-profile";
import { renderImplementationSpecification } from "./hybrid-specification";
import { SEMANTIC_LIMITS } from "./semantic-limits";
import { sha256 } from "./stable-hash";
import { instantiateWasmPredicate } from "./wasm-runtime";
import { WASM_LIMITS } from "./wasm-contract";

export const HYBRID_ARTIFACT_KIND = "hybrid-imported-predicate" as const;
const roles = [
  "source",
  "typescriptProfile",
  "resolution",
  "jsonSchema",
  "specification",
  "build",
  "wasm",
] as const;
export type HybridArtifactFileRole = (typeof roles)[number];
export type HybridArtifactFile = { path: string; hash: string };
export type HybridArtifactManifest = {
  version: 1;
  kind: typeof HYBRID_ARTIFACT_KIND;
  profile: "predicate-i32-v1";
  functionName: string;
  files: Record<HybridArtifactFileRole, HybridArtifactFile>;
};

const fixedPaths: Partial<Record<HybridArtifactFileRole, string>> = {
  source: "source.ts",
  typescriptProfile: "typescript.json",
  resolution: "resolution.json",
  jsonSchema: "schema.json",
  specification: "specification.md",
  build: "build.json",
};

export function parseHybridArtifactManifest(
  input: unknown,
): HybridArtifactManifest {
  const root = dataRecord(input, "artifact", [
    "version",
    "kind",
    "profile",
    "functionName",
    "files",
  ]);
  exactKeys(root, "artifact", [
    "version",
    "kind",
    "profile",
    "functionName",
    "files",
  ]);
  if (
    root.version !== 1 ||
    root.kind !== HYBRID_ARTIFACT_KIND ||
    root.profile !== "predicate-i32-v1"
  ) {
    invalid("unsupported hybrid artifact manifest");
  }
  const rawFiles = dataRecord(root.files, "artifact.files", roles);
  exactKeys(rawFiles, "artifact.files", roles);
  const files = {} as Record<HybridArtifactFileRole, HybridArtifactFile>;
  const seen = new Set<string>();
  for (const role of roles) {
    const raw = dataRecord(rawFiles[role], `artifact.files.${role}`, [
      "path",
      "hash",
    ]);
    exactKeys(raw, `artifact.files.${role}`, ["path", "hash"]);
    if (
      typeof raw.path !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.path) ||
      raw.path === "artifact.json" ||
      seen.has(raw.path)
    ) {
      invalid(`invalid or duplicate artifact path for ${role}`);
    }
    const fixed = fixedPaths[role];
    if (fixed !== undefined && raw.path !== fixed) {
      invalid(`unexpected artifact path for ${role}`);
    }
    if (role === "wasm" && !/^[a-f0-9]{64}\.wasm$/.test(raw.path)) {
      invalid("invalid Wasm artifact path");
    }
    seen.add(raw.path);
    files[role] = {
      path: raw.path,
      hash: hash(raw.hash, `artifact.files.${role}.hash`),
    };
  }
  return {
    version: 1,
    kind: HYBRID_ARTIFACT_KIND,
    profile: "predicate-i32-v1",
    functionName: identifier(root.functionName, "artifact.functionName"),
    files,
  };
}

export function hybridArtifactHash(input: unknown): string {
  return canonicalHash(parseHybridArtifactManifest(input));
}

export type LoadedHybridArtifact = {
  manifestPath: string;
  manifest: HybridArtifactManifest;
  artifactHash: string;
  typescriptProfile: HybridTypeScriptProfile;
  resolution: HybridImportResolution;
  build: HybridBuildManifest;
  source: Uint8Array;
  jsonSchema: Uint8Array;
  specification: Uint8Array;
  wasm: Uint8Array;
};

export async function readHybridArtifact(
  manifestPath: string,
): Promise<LoadedHybridArtifact> {
  const manifestBytes = await plainBoundedBytes(
    resolve(manifestPath),
    SEMANTIC_LIMITS.externalJsonBytes,
  );
  const manifest = parseHybridArtifactManifest(
    json(manifestBytes, "artifact manifest"),
  );
  const root = await realpath(dirname(resolve(manifestPath)));
  const files = {} as Record<HybridArtifactFileRole, Uint8Array>;
  for (const role of roles) {
    const ref = manifest.files[role];
    const path = await resolveContainedFile(
      root,
      ref.path,
      `artifact ${role}`,
      {
        containmentLabel: "artifact directory",
        rejectSymbolicLinks: true,
      },
    );
    files[role] = await plainBoundedBytes(
      path,
      role === "source"
        ? SEMANTIC_LIMITS.typescriptSourceBytes
        : WASM_LIMITS.bytes,
    );
    if (sha256(files[role]) !== ref.hash) {
      throw new HybridArtifactError(
        "ARTIFACT_MISMATCH",
        `${role} hash mismatch`,
      );
    }
  }
  const typescriptProfile = parseHybridTypeScriptProfile(
    json(files.typescriptProfile, "TypeScript profile"),
  );
  const resolution = parseHybridImportResolution(
    json(files.resolution, "import resolution"),
    typescriptProfile,
  );
  const build = parseHybridBuildManifest(
    json(files.build, "build manifest"),
    resolution,
  );
  if (
    manifest.functionName !== resolution.source.functionName ||
    sha256(files.source) !== resolution.source.sourceHash ||
    hybridTypeScriptProfileHash(typescriptProfile) !==
      resolution.typescript.optionsHash ||
    hybridImportResolutionHash(resolution) !== build.resolutionHash ||
    build.wasmHash !== manifest.files.wasm.hash ||
    build.file !== manifest.files.wasm.path
  ) {
    throw new HybridArtifactError(
      "ARTIFACT_MISMATCH",
      "artifact linkage mismatch",
    );
  }
  const jsonSchema = projectCanonicalTypeToJsonSchema(
    resolution.input.canonicalType,
  );
  if (
    canonicalJson(jsonSchema) !== new TextDecoder().decode(files.jsonSchema)
  ) {
    throw new HybridArtifactError(
      "ARTIFACT_MISMATCH",
      "JSON Schema projection mismatch",
    );
  }
  const specification = renderImplementationSpecification({
    functionName: resolution.source.functionName,
    parameterName: resolution.input.parameterName,
    canonicalType: resolution.input.canonicalType,
    expression: resolution.body,
    jsonSchema,
  });
  if (specification.content !== new TextDecoder().decode(files.specification)) {
    throw new HybridArtifactError(
      "ARTIFACT_MISMATCH",
      "specification projection mismatch",
    );
  }
  if (
    sha256(files.wasm) !== build.wasmHash ||
    !WebAssembly.validate(files.wasm)
  ) {
    throw new HybridArtifactError("ARTIFACT_MISMATCH", "invalid Wasm bytes");
  }
  if (
    sha256(
      await plainBoundedBytes(
        resolve(manifestPath),
        SEMANTIC_LIMITS.externalJsonBytes,
      ),
    ) !== sha256(manifestBytes)
  ) {
    throw new HybridArtifactError(
      "ARTIFACT_MISMATCH",
      "artifact manifest changed while reading",
    );
  }
  return {
    manifestPath: resolve(manifestPath),
    manifest,
    artifactHash: hybridArtifactHash(manifest),
    typescriptProfile,
    resolution,
    build,
    source: files.source,
    jsonSchema: files.jsonSchema,
    specification: files.specification,
    wasm: files.wasm,
  };
}

export async function verifyImportedPredicateArtifact(manifestPath: string) {
  const artifact = await readHybridArtifact(manifestPath);
  const runtime = await instantiateWasmPredicate(artifact.build, artifact.wasm);
  runtime.evaluate(minimalValidInput(artifact.build));
  let invalidRejected = false;
  try {
    runtime.evaluate({ __unexpected: true });
  } catch {
    invalidRejected = true;
  }
  if (!invalidRejected) invalid("runtime accepted an invalid input");
  return {
    version: 1 as const,
    mode: "portable" as const,
    status: "passed" as const,
    artifactHash: artifact.artifactHash,
    semanticHash: artifact.resolution.semanticHash,
    wasmHash: artifact.build.wasmHash,
    completedAt: new Date().toISOString(),
    apiCalls: 0 as const,
    writes: 0 as const,
  };
}

export async function loadImportedPredicateArtifact(manifestPath: string) {
  const artifact = await readHybridArtifact(manifestPath);
  const runtime = await instantiateWasmPredicate(artifact.build, artifact.wasm);
  return {
    artifactHash: artifact.artifactHash,
    semanticHash: artifact.resolution.semanticHash,
    evaluate: runtime.evaluate,
  };
}

function minimalValidInput(
  build: HybridBuildManifest,
): Record<string, unknown> {
  return Object.fromEntries(
    build.contract.fields.map((field) => {
      if (field.kind === "boolean") return [field.name, false];
      if (field.kind === "enum") return [field.name, field.values[0]];
      return [field.name, ""];
    }),
  );
}

async function plainBoundedBytes(
  path: string,
  maximum: number,
): Promise<Uint8Array> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    invalid("artifact entries must be regular non-symlink files");
  }
  if ((await stat(path)).size > maximum)
    invalid("artifact entry exceeds size limit");
  const bytes = await readFile(path);
  if (bytes.byteLength > maximum) invalid("artifact entry exceeds size limit");
  return new Uint8Array(bytes);
}

function json(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    invalid(`${label} must contain valid UTF-8 JSON`, error);
  }
}
