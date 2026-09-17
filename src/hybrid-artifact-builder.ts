import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  hybridArtifactHash,
  parseHybridArtifactManifest,
  verifyImportedPredicateArtifact,
  type HybridArtifactFileRole,
} from "./hybrid-artifact";
import { parseHybridBuildManifest } from "./hybrid-build-manifest";
import {
  canonicalHash,
  canonicalJson,
  HybridArtifactError,
} from "./hybrid-artifact-values";
import {
  hybridImportResolutionHash,
  parseHybridImportResolution,
} from "./hybrid-import-resolution";
import {
  assertClosedHybridSource,
  importIsolatedHybridPredicate,
} from "./hybrid-isolated-import";
import {
  createHybridTypeScriptProfile,
  hybridTypeScriptProfileHash,
} from "./hybrid-typescript-profile";
import { SEMANTIC_LIMITS } from "./semantic-limits";
import { fingerprintFor, sha256 } from "./stable-hash";
import {
  importTypeScriptPredicate,
  type ImportedTypeScriptPredicate,
} from "./typescript-predicate-importer";
import { resolveContainedFile } from "./contained-path";
import {
  emitWasm,
  WASM_BACKEND_VERSION,
  WASM_COMPILER_VERSION,
} from "./wasm-emitter";

export async function buildImportedPredicateArtifact(
  input: {
    workspaceRoot: string;
    sourcePath: string;
    functionName: string;
    outputDirectory: string;
  },
  dependencies: {
    writeFile?: typeof writeFile;
    rename?: typeof rename;
    afterImport?: () => void | Promise<void>;
  } = {},
) {
  const write = dependencies.writeFile ?? writeFile;
  const move = dependencies.rename ?? rename;
  const workspaceRoot = resolve(input.workspaceRoot);
  const sourcePath = await resolveContainedFile(
    workspaceRoot,
    input.sourcePath,
    "TypeScript source",
    { rejectSymbolicLinks: true },
  );
  const source = new Uint8Array(await readFile(sourcePath));
  if (source.byteLength > SEMANTIC_LIMITS.typescriptSourceBytes) {
    throw new HybridArtifactError(
      "INVALID_ARGUMENT",
      "source exceeds size limit",
    );
  }
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    throw new HybridArtifactError(
      "INVALID_ARGUMENT",
      "source must contain valid UTF-8",
      { cause: error },
    );
  }
  assertClosedHybridSource(sourceText);
  const sourceHash = sha256(source);
  const inspected = await importTypeScriptPredicate({
    workspaceRoot,
    sourcePath,
    functionName: input.functionName,
  });
  if (inspected.source.sourceHash !== sourceHash) {
    throw new HybridArtifactError(
      "SOURCE_CHANGED",
      "source changed while importing",
    );
  }
  const typescriptProfile = createHybridTypeScriptProfile();
  const isolated = await importIsolatedHybridPredicate({
    source,
    functionName: input.functionName,
    profile: typescriptProfile,
  });
  assertEquivalentImports(inspected, isolated);
  await dependencies.afterImport?.();

  const resolution = parseHybridImportResolution(
    {
      version: 1,
      profile: "predicate-i32-v1",
      source: {
        file: "source.ts",
        functionName: inspected.source.functionName,
        sourceHash,
      },
      typescript: {
        profile: typescriptProfile.profile,
        version: typescriptProfile.typescriptVersion,
        optionsHash: hybridTypeScriptProfileHash(typescriptProfile),
      },
      input: {
        parameterName: inspected.input.parameterName,
        typeName: inspected.input.typeName,
        canonicalType: inspected.input.canonicalType,
        canonicalTypeHash: inspected.input.canonicalTypeHash,
      },
      body: inspected.body,
      semanticHash: inspected.semanticHash,
    },
    typescriptProfile,
  );
  const wasm = emitWasm(resolution.body, inspected.contract);
  const wasmHash = sha256(wasm);
  const build = parseHybridBuildManifest(
    {
      version: 1,
      profile: "predicate-i32-v1",
      export: "evaluate",
      resolutionHash: hybridImportResolutionHash(resolution),
      canonicalTypeHash: resolution.input.canonicalTypeHash,
      semanticHash: resolution.semanticHash,
      contract: inspected.contract,
      contractHash: fingerprintFor(inspected.contract),
      compiler: WASM_COMPILER_VERSION,
      backend: `binaryen@${WASM_BACKEND_VERSION}`,
      options: "mvp-no-optimization",
      wasmHash,
      file: `${wasmHash}.wasm`,
    },
    resolution,
  );

  const content: Record<HybridArtifactFileRole, Uint8Array> = {
    source,
    typescriptProfile: bytes(canonicalJson(typescriptProfile)),
    resolution: bytes(canonicalJson(resolution)),
    jsonSchema: bytes(canonicalJson(inspected.projections.jsonSchema)),
    specification: bytes(inspected.projections.specification.content),
    build: bytes(canonicalJson(build)),
    wasm,
  };
  const paths: Record<HybridArtifactFileRole, string> = {
    source: "source.ts",
    typescriptProfile: "typescript.json",
    resolution: "resolution.json",
    jsonSchema: "schema.json",
    specification: "specification.md",
    build: "build.json",
    wasm: build.file,
  };
  const files = Object.fromEntries(
    (Object.keys(paths) as HybridArtifactFileRole[]).map((role) => [
      role,
      { path: paths[role], hash: sha256(content[role]) },
    ]),
  );
  const manifest = parseHybridArtifactManifest({
    version: 1,
    kind: "hybrid-imported-predicate",
    profile: "predicate-i32-v1",
    functionName: resolution.source.functionName,
    files,
  });
  const outputDirectory = resolve(workspaceRoot, input.outputDirectory);
  const parent = dirname(outputDirectory);
  await ensureContainedDirectory(workspaceRoot, parent);
  if (await exists(outputDirectory)) {
    throw new HybridArtifactError(
      "OUTPUT_EXISTS",
      "output directory already exists",
    );
  }
  const temporary = await mkdtemp(resolve(parent, ".hybrid-artifact-"));
  let published = false;
  try {
    for (const role of Object.keys(paths) as HybridArtifactFileRole[]) {
      await write(resolve(temporary, paths[role]), content[role], {
        flag: "wx",
        mode: 0o600,
      });
    }
    await write(resolve(temporary, "artifact.json"), canonicalJson(manifest), {
      flag: "wx",
      mode: 0o600,
    });
    await verifyImportedPredicateArtifact(resolve(temporary, "artifact.json"));
    if (sha256(new Uint8Array(await readFile(sourcePath))) !== sourceHash) {
      throw new HybridArtifactError(
        "SOURCE_CHANGED",
        "source changed during build",
      );
    }
    if (await exists(outputDirectory)) {
      throw new HybridArtifactError(
        "OUTPUT_EXISTS",
        "output directory already exists",
      );
    }
    try {
      await move(temporary, outputDirectory);
    } catch (error) {
      if (await exists(outputDirectory)) {
        throw new HybridArtifactError(
          "OUTPUT_EXISTS",
          "output directory already exists",
          {
            cause: error,
          },
        );
      }
      throw new HybridArtifactError(
        "PUBLICATION_FAILED",
        "could not publish artifact",
        {
          cause: error,
        },
      );
    }
    published = true;
    return {
      manifest: resolve(outputDirectory, "artifact.json"),
      artifactHash: hybridArtifactHash(manifest),
      semanticHash: resolution.semanticHash,
      wasmHash,
      apiCalls: 0 as const,
    };
  } catch (error) {
    if (error instanceof HybridArtifactError) throw error;
    throw new HybridArtifactError(
      "PUBLICATION_FAILED",
      "artifact publication failed",
      { cause: error },
    );
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}

function assertEquivalentImports(
  workspace: ImportedTypeScriptPredicate,
  isolated: ImportedTypeScriptPredicate,
): void {
  const left = {
    canonicalType: workspace.input.canonicalType,
    body: workspace.body,
    contract: workspace.contract,
    semanticHash: workspace.semanticHash,
    jsonSchema: workspace.projections.jsonSchema,
    specification: workspace.projections.specification.content,
  };
  const right = {
    canonicalType: isolated.input.canonicalType,
    body: isolated.body,
    contract: isolated.contract,
    semanticHash: isolated.semanticHash,
    jsonSchema: isolated.projections.jsonSchema,
    specification: isolated.projections.specification.content,
  };
  if (canonicalHash(left) !== canonicalHash(right)) {
    throw new HybridArtifactError(
      "REBUILD_MISMATCH",
      "workspace and isolated TypeScript profiles disagree",
    );
  }
}

async function ensureContainedDirectory(
  rootPath: string,
  directory: string,
): Promise<void> {
  const root = await realpath(rootPath);
  const relation = relative(root, resolve(directory));
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new HybridArtifactError(
      "INVALID_ARGUMENT",
      "output must stay inside workspace",
    );
  }
  let current = root;
  for (const segment of relation.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new HybridArtifactError(
          "INVALID_ARGUMENT",
          "output parent must be a non-symlink directory",
        );
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
