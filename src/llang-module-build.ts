import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { emitModuleWasm } from "./llang-module-wasm";
import {
  emitModuleJsonc,
  emitModuleTypeScript,
} from "./llang-module-source-emitter";
import {
  loadModuleProgram,
  revalidateModuleSnapshot,
} from "./llang-module-loader";
import { digest, parseContract, type WasmContract } from "./wasm-contract";
import { resolveImportId, type CheckedModuleProgram } from "./llang-module-ir";
import { resolveContainedFile } from "./contained-path";
import { parseStrictJsonObject } from "./llang-jsonc";
import ts from "typescript";

export type ModuleTarget = "typescript" | "jsonc" | "wasm";
export type ModuleBuildManifest = {
  format: "llang-module-build";
  version: 1;
  profile: "module-bool-v1";
  entry: string;
  sourceSetHash: string;
  programHash: string;
  interfaceHash: string;
  sources: { path: string; hash: string }[];
  dependencies: { from: string; to: string }[];
  targets: ModuleTarget[];
  artifacts: { path: string; hash: string; bytes: number }[];
  wasm?: {
    path: string;
    export: "evaluate";
    contract: WasmContract;
    wasmHash: string;
  };
  toolchain: { compiler: string; binaryen: string; typescript: string };
};

const MODULE_MANIFEST_BYTES = 1024 * 1024;
const MODULE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MODULE_ARTIFACT_COUNT = 128;
const MODULE_SOURCE_COUNT = 64;
const MODULE_DEPENDENCY_COUNT = 1024;
const HASH = /^[0-9a-f]{64}$/;

function artifactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`INVALID_ARTIFACT: ${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)))
    throw new Error(`INVALID_ARTIFACT: unknown ${label} field`);
  return record;
}

function artifactPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "." ||
    value.startsWith("../")
  )
    throw new Error("INVALID_ARTIFACT: invalid artifact path");
  return value;
}

async function writeArtifact(
  root: string,
  path: string,
  data: string | Uint8Array,
  artifacts: ModuleBuildManifest["artifacts"],
): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, data);
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  artifacts.push({ path, hash: digest(bytes), bytes: bytes.byteLength });
}

export async function buildModuleProgram(options: {
  entry: string;
  root: string;
  entryName: string;
  target?: ModuleTarget | "all";
  outDir: string;
}): Promise<ModuleBuildManifest> {
  const program = await loadModuleProgram(
    options.entry,
    options.root,
    options.entryName,
  );
  return buildCheckedModuleProgram(
    program,
    options.outDir,
    options.target ?? "all",
  );
}

export async function buildCheckedModuleProgram(
  program: CheckedModuleProgram,
  outDir: string,
  target: ModuleTarget | "all" = "all",
): Promise<ModuleBuildManifest> {
  const out = resolve(outDir);
  await mkdir(out);
  let owned = true;
  try {
    const targets: ModuleTarget[] =
        target === "all" ? ["typescript", "jsonc", "wasm"] : [target],
      artifacts: ModuleBuildManifest["artifacts"] = [];
    if (targets.includes("typescript")) {
      await writeArtifact(
        out,
        "typescript/program.generated.ts",
        emitModuleTypeScript(program),
        artifacts,
      );
      const generated = join(out, "typescript/program.generated.ts"),
        diagnostics = ts.getPreEmitDiagnostics(
          ts.createProgram([generated], {
            strict: true,
            noEmit: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            skipLibCheck: true,
            types: [],
            noResolve: true,
          }),
        );
      if (diagnostics.length)
        throw new Error(
          `generated TypeScript failed typecheck: ${ts.flattenDiagnosticMessageText(diagnostics[0]?.messageText ?? "unknown diagnostic", "\n")}`,
        );
    }
    if (targets.includes("jsonc")) {
      for (const [path, text] of emitModuleJsonc(program))
        await writeArtifact(out, `jsonc/${path}`, text, artifacts);
      const [entryModule, entryName] = program.entry.split("#") as [
        string,
        string,
      ];
      const roundTrip = await loadModuleProgram(
        `${entryModule}.llang.jsonc`,
        join(out, "jsonc"),
        entryName,
      );
      if (
        roundTrip.programHash !== program.programHash ||
        roundTrip.interfaceHash !== program.interfaceHash
      )
        throw new Error("generated JSONC round-trip changed program meaning");
    }
    let wasm: ModuleBuildManifest["wasm"];
    if (targets.includes("wasm")) {
      const emitted = emitModuleWasm(program),
        path = "wasm/program.wasm",
        wasmHash = digest(emitted.bytes);
      await writeArtifact(out, path, emitted.bytes, artifacts);
      wasm = { path, export: "evaluate", contract: emitted.contract, wasmHash };
    }
    await revalidateModuleSnapshot(program);
    const manifest: ModuleBuildManifest = {
      format: "llang-module-build",
      version: 1,
      profile: "module-bool-v1",
      entry: program.entry,
      sourceSetHash: program.sourceSetHash,
      programHash: program.programHash,
      interfaceHash: program.interfaceHash,
      sources: program.modules.map((m) => ({
        path: m.relativePath,
        hash: m.sourceHash,
      })),
      dependencies: program.modules.flatMap((m) =>
        m.source.imports.map((x) => ({
          from: m.id,
          to: resolveImportId(m.id, x.from),
        })),
      ),
      targets,
      artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
      ...(wasm ? { wasm } : {}),
      toolchain: {
        compiler: "0.1.0-dev.1",
        binaryen: "132.0.0",
        typescript: "5.9.3",
      },
    };
    const temporary = join(out, ".module-build.json.tmp");
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temporary, join(out, "module-build.json"));
    owned = false;
    return manifest;
  } catch (error) {
    if (owned) await rm(out, { recursive: true, force: true });
    throw error;
  }
}

export async function readModuleBuildManifest(path: string): Promise<{
  manifest: ModuleBuildManifest;
  root: string;
  artifactBytes: Map<string, Uint8Array>;
}> {
  const absolute = resolve(path),
    info = await lstat(absolute);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MODULE_MANIFEST_BYTES
  )
    throw new Error(
      "INVALID_ARTIFACT: manifest must be a bounded regular file",
    );
  const raw = await readFile(absolute);
  if (raw.byteLength > MODULE_MANIFEST_BYTES)
    throw new Error("INVALID_ARTIFACT: manifest exceeds byte limit");
  const value = parseStrictJsonObject(
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
    absolute,
  ) as ModuleBuildManifest;
  const known = new Set([
    "format",
    "version",
    "profile",
    "entry",
    "sourceSetHash",
    "programHash",
    "interfaceHash",
    "sources",
    "dependencies",
    "targets",
    "artifacts",
    "wasm",
    "toolchain",
  ]);
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => !known.has(key))
  )
    throw new Error("INVALID_ARTIFACT: unknown module build field");
  if (
    value.format !== "llang-module-build" ||
    value.version !== 1 ||
    value.profile !== "module-bool-v1" ||
    typeof value.entry !== "string" ||
    typeof value.sourceSetHash !== "string" ||
    !HASH.test(value.sourceSetHash) ||
    typeof value.programHash !== "string" ||
    !HASH.test(value.programHash) ||
    typeof value.interfaceHash !== "string" ||
    !HASH.test(value.interfaceHash) ||
    !Array.isArray(value.sources) ||
    !value.sources.length ||
    value.sources.length > MODULE_SOURCE_COUNT ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > MODULE_DEPENDENCY_COUNT ||
    !Array.isArray(value.artifacts) ||
    !value.artifacts.length ||
    value.artifacts.length > MODULE_ARTIFACT_COUNT ||
    !Array.isArray(value.targets) ||
    !value.targets.length ||
    value.targets.length > 3 ||
    new Set(value.targets).size !== value.targets.length ||
    value.targets.some(
      (target) => !["typescript", "jsonc", "wasm"].includes(target),
    )
  )
    throw new Error("INVALID_ARTIFACT: invalid module build manifest");
  const root = dirname(absolute);
  const artifactBytes = new Map<string, Uint8Array>();
  let totalArtifactBytes = 0;
  for (const rawArtifact of value.artifacts) {
    const artifact = artifactRecord(
        rawArtifact,
        ["path", "hash", "bytes"],
        "artifact",
      ),
      relativePath = artifactPath(artifact.path);
    if (
      relativePath !== "typescript/program.generated.ts" &&
      relativePath !== "wasm/program.wasm" &&
      !(
        relativePath.startsWith("jsonc/") &&
        relativePath.endsWith(".llang.jsonc")
      )
    )
      throw new Error("INVALID_ARTIFACT: unexpected artifact role");
    if (
      typeof artifact.hash !== "string" ||
      !HASH.test(artifact.hash) ||
      !Number.isSafeInteger(artifact.bytes) ||
      Number(artifact.bytes) < 0 ||
      Number(artifact.bytes) > MODULE_ARTIFACT_BYTES ||
      artifactBytes.has(relativePath)
    )
      throw new Error("INVALID_ARTIFACT: invalid artifact inventory");
    const artifactAbsolute = await resolveContainedFile(
      root,
      relativePath,
      "module artifact",
      { containmentLabel: "module bundle", rejectSymbolicLinks: true },
    );
    const bytes = await readFile(artifactAbsolute);
    totalArtifactBytes += bytes.byteLength;
    if (
      totalArtifactBytes > MODULE_ARTIFACT_BYTES ||
      bytes.byteLength !== artifact.bytes ||
      digest(bytes) !== artifact.hash
    )
      throw new Error(`ARTIFACT_MISMATCH: ${relativePath}`);
    artifactBytes.set(relativePath, bytes);
  }
  if (
    value.targets.includes("typescript") !==
    artifactBytes.has("typescript/program.generated.ts")
  )
    throw new Error("ARTIFACT_MISMATCH: invalid TypeScript inventory");
  if (
    value.targets.includes("jsonc") !==
    [...artifactBytes.keys()].some((item) => item.startsWith("jsonc/"))
  )
    throw new Error("ARTIFACT_MISMATCH: invalid JSONC inventory");
  const sourcePaths = new Set<string>();
  if (
    value.sources.some((rawSource) => {
      const source = artifactRecord(rawSource, ["path", "hash"], "source"),
        sourcePath = artifactPath(source.path);
      if (sourcePaths.has(sourcePath)) return true;
      sourcePaths.add(sourcePath);
      return (
        (!sourcePath.endsWith(".ts") && !sourcePath.endsWith(".llang.jsonc")) ||
        typeof source.hash !== "string" ||
        !HASH.test(source.hash)
      );
    })
  )
    throw new Error("INVALID_ARTIFACT: invalid source inventory");
  if (
    value.dependencies.some((rawDependency) => {
      const dependency = artifactRecord(
        rawDependency,
        ["from", "to"],
        "dependency",
      );
      return (
        typeof dependency.from !== "string" ||
        !dependency.from ||
        typeof dependency.to !== "string" ||
        !dependency.to
      );
    })
  )
    throw new Error("INVALID_ARTIFACT: invalid dependency inventory");
  const sourceIds = new Set(
    [...sourcePaths].map((sourcePath) =>
      sourcePath.endsWith(".llang.jsonc")
        ? sourcePath.slice(0, -".llang.jsonc".length)
        : sourcePath.slice(0, -".ts".length),
    ),
  );
  if (
    sourceIds.size !== sourcePaths.size ||
    !value.entry.includes("#") ||
    !sourceIds.has(value.entry.slice(0, value.entry.lastIndexOf("#"))) ||
    value.dependencies.some(
      (dependency) =>
        !sourceIds.has(dependency.from) || !sourceIds.has(dependency.to),
    )
  )
    throw new Error("INVALID_ARTIFACT: inconsistent source inventory");
  const jsoncArtifacts = new Set(
    [...artifactBytes.keys()].filter((item) => item.startsWith("jsonc/")),
  );
  const expectedJsoncArtifacts = new Set(
    [...sourceIds].map((id) => `jsonc/${id}.llang.jsonc`),
  );
  if (
    value.targets.includes("jsonc") &&
    (jsoncArtifacts.size !== expectedJsoncArtifacts.size ||
      [...expectedJsoncArtifacts].some((path) => !jsoncArtifacts.has(path)))
  )
    throw new Error("ARTIFACT_MISMATCH: invalid JSONC inventory");
  const toolchain = artifactRecord(
    value.toolchain,
    ["compiler", "binaryen", "typescript"],
    "toolchain",
  );
  if (
    typeof toolchain.compiler !== "string" ||
    typeof toolchain.binaryen !== "string" ||
    typeof toolchain.typescript !== "string"
  )
    throw new Error("INVALID_ARTIFACT: invalid toolchain");
  if (value.targets.includes("wasm")) {
    const wasm = artifactRecord(
        value.wasm,
        ["path", "export", "contract", "wasmHash"],
        "wasm",
      ),
      wasmPath = artifactPath(wasm.path),
      wasmHash = value.artifacts.find((item) => item.path === wasmPath)?.hash;
    if (
      wasmPath !== "wasm/program.wasm" ||
      wasm.export !== "evaluate" ||
      typeof wasm.wasmHash !== "string" ||
      !HASH.test(wasm.wasmHash) ||
      wasm.wasmHash !== wasmHash ||
      !artifactBytes.has(wasmPath)
    )
      throw new Error("ARTIFACT_MISMATCH: invalid Wasm inventory");
    parseContract(wasm.contract);
  } else if (value.wasm !== undefined) {
    throw new Error("ARTIFACT_MISMATCH: unexpected Wasm inventory");
  }
  return { manifest: value, root, artifactBytes };
}
