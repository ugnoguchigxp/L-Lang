import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import ts from "typescript";
import { resolveContainedFile } from "./contained-path";
import { parseStrictJsonObject } from "./llang-jsonc";
import { digest } from "./wasm-contract";
import {
  loadCollectionModuleProgram,
  revalidateCollectionModuleSnapshot,
} from "./llang-module-collection-loader";
import {
  emitCollectionModuleJsonc,
  emitCollectionModuleTypeScript,
} from "./llang-module-collection-source-emitter";
import {
  emitCollectionModuleWasm,
  type CollectionWasmContract,
} from "./llang-module-collection-wasm";
import {
  assertCollectionWasmBinary,
  assertCollectionWasmContract,
} from "./llang-module-collection-runtime";

export type CollectionModuleTarget = "typescript" | "jsonc" | "wasm";
export type CollectionModuleBuildManifest = {
  format: "llang-module-build";
  version: 3;
  profile: "module-collection-v1";
  abi: "llang-collection-memory-v1";
  entry: string;
  sourceSetHash: string;
  programHash: string;
  loweredHash: string;
  interfaceHash: string;
  layoutHash: string;
  resources: {
    memoryPages: 128;
    stringBytes: 16384;
    wireBytes: 262144;
    listElements: 4096;
    totalListElements: 16384;
    arenaBytes: 4194304;
    fuel: 1000000;
    callDepth: 64;
  };
  sources: { path: string; hash: string }[];
  dependencies: { from: string; to: string }[];
  targets: CollectionModuleTarget[];
  artifacts: { path: string; hash: string; bytes: number }[];
  wasm?: {
    path: string;
    export: "evaluate";
    contract: CollectionWasmContract;
    wasmHash: string;
  };
  toolchain: { compiler: string; binaryen: string; typescript: string };
};
async function writeArtifact(
  root: string,
  path: string,
  data: string | Uint8Array,
  output: CollectionModuleBuildManifest["artifacts"],
): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, data);
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  output.push({ path, hash: digest(bytes), bytes: bytes.length });
}
export async function buildCollectionModuleProgram(options: {
  entry: string;
  root: string;
  entryName: string;
  target?: CollectionModuleTarget | "all";
  outDir: string;
}): Promise<CollectionModuleBuildManifest> {
  const program = await loadCollectionModuleProgram(
      options.entry,
      options.root,
      options.entryName,
    ),
    out = resolve(options.outDir);
  await mkdir(out);
  let owned = true;
  try {
    const targets: CollectionModuleTarget[] =
        options.target && options.target !== "all"
          ? [options.target]
          : ["typescript", "jsonc", "wasm"],
      artifacts: CollectionModuleBuildManifest["artifacts"] = [];
    if (targets.includes("typescript")) {
      const text = emitCollectionModuleTypeScript(program),
        path = join(out, "typescript/program.generated.ts");
      await writeArtifact(
        out,
        "typescript/program.generated.ts",
        text,
        artifacts,
      );
      const diagnostics = ts.getPreEmitDiagnostics(
        ts.createProgram([path], {
          strict: true,
          noEmit: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          skipLibCheck: true,
          types: [],
          noResolve: true,
          lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
        }),
      );
      const diagnostic = diagnostics[0];
      if (diagnostic)
        throw new Error(
          `generated TypeScript failed typecheck: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
        );
    }
    if (targets.includes("jsonc")) {
      for (const [path, text] of emitCollectionModuleJsonc(program))
        await writeArtifact(out, `jsonc/${path}`, text, artifacts);
      const entryId = program.entry.slice(0, program.entry.lastIndexOf("#")),
        roundTrip = await loadCollectionModuleProgram(
          `${entryId}.llang.jsonc`,
          join(out, "jsonc"),
          options.entryName,
        );
      if (
        roundTrip.programHash !== program.programHash ||
        roundTrip.interfaceHash !== program.interfaceHash ||
        roundTrip.layoutHash !== program.layoutHash ||
        roundTrip.loweredHash !== program.loweredHash
      )
        throw new Error("generated JSONC round-trip changed program meaning");
    }
    let wasm: CollectionModuleBuildManifest["wasm"];
    if (targets.includes("wasm")) {
      const emitted = emitCollectionModuleWasm(program),
        path = "wasm/program.wasm",
        wasmHash = digest(emitted.bytes);
      assertCollectionWasmContract(emitted.contract);
      assertCollectionWasmBinary(emitted.bytes);
      await writeArtifact(out, path, emitted.bytes, artifacts);
      wasm = { path, export: "evaluate", contract: emitted.contract, wasmHash };
    }
    await revalidateCollectionModuleSnapshot(program);
    const manifest: CollectionModuleBuildManifest = {
      format: "llang-module-build",
      version: 3,
      profile: "module-collection-v1",
      abi: "llang-collection-memory-v1",
      entry: program.entry,
      sourceSetHash: program.sourceSetHash,
      programHash: program.programHash,
      loweredHash: program.loweredHash,
      interfaceHash: program.interfaceHash,
      layoutHash: program.layoutHash,
      resources: {
        memoryPages: 128,
        stringBytes: 16384,
        wireBytes: 262144,
        listElements: 4096,
        totalListElements: 16384,
        arenaBytes: 4194304,
        fuel: 1000000,
        callDepth: 64,
      },
      sources: program.modules.map((x) => ({
        path: x.relativePath,
        hash: x.sourceHash,
      })),
      dependencies: program.modules.flatMap((m) =>
        m.source.imports.map((x) => ({
          from: m.id,
          to: posix.normalize(
            posix.join(
              posix.dirname(m.id),
              x.from.replace(/\.llang\.jsonc$|\.ts$/, ""),
            ),
          ),
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
const safePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.split("/").includes("..");
const HASH = /^[0-9a-f]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
};
export async function readCollectionModuleBuildManifest(path: string): Promise<{
  manifest: CollectionModuleBuildManifest;
  artifactBytes: Map<string, Uint8Array>;
}> {
  const absolute = resolve(path),
    info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
    throw new Error("INVALID_ARTIFACT: invalid collection manifest file");
  const parsed = parseStrictJsonObject(
    new TextDecoder("utf-8", { fatal: true }).decode(await readFile(absolute)),
    absolute,
  );
  if (!isRecord(parsed))
    throw new Error("INVALID_ARTIFACT: invalid collection manifest");
  const hasWasm = Object.hasOwn(parsed, "wasm"),
    topKeys = [
      "format",
      "version",
      "profile",
      "abi",
      "entry",
      "sourceSetHash",
      "programHash",
      "loweredHash",
      "interfaceHash",
      "layoutHash",
      "resources",
      "sources",
      "dependencies",
      "targets",
      "artifacts",
      "toolchain",
      ...(hasWasm ? ["wasm"] : []),
    ];
  if (!exactKeys(parsed, topKeys))
    throw new Error("INVALID_ARTIFACT: invalid collection manifest keys");
  const value = parsed as CollectionModuleBuildManifest;
  if (
    value.format !== "llang-module-build" ||
    value.version !== 3 ||
    value.profile !== "module-collection-v1" ||
    value.abi !== "llang-collection-memory-v1" ||
    typeof value.entry !== "string" ||
    !value.entry.includes("#") ||
    value.entry.length > 1024 ||
    !HASH.test(value.sourceSetHash) ||
    !HASH.test(value.programHash) ||
    !HASH.test(value.loweredHash) ||
    !HASH.test(value.interfaceHash) ||
    !HASH.test(value.layoutHash) ||
    !Array.isArray(value.targets) ||
    !value.targets.length ||
    value.targets.length > 3 ||
    new Set(value.targets).size !== value.targets.length ||
    value.targets.some(
      (target) => !["typescript", "jsonc", "wasm"].includes(target),
    ) ||
    !Array.isArray(value.artifacts) ||
    !value.artifacts.length ||
    value.artifacts.length > 512 ||
    !Array.isArray(value.sources) ||
    !value.sources.length ||
    value.sources.length > 256 ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 4096 ||
    !isRecord(value.resources) ||
    !exactKeys(value.resources, [
      "memoryPages",
      "stringBytes",
      "wireBytes",
      "listElements",
      "totalListElements",
      "arenaBytes",
      "fuel",
      "callDepth",
    ]) ||
    value.resources.memoryPages !== 128 ||
    value.resources.stringBytes !== 16384 ||
    value.resources.wireBytes !== 262144 ||
    value.resources.listElements !== 4096 ||
    value.resources.totalListElements !== 16384 ||
    value.resources.arenaBytes !== 4194304 ||
    value.resources.fuel !== 1000000 ||
    value.resources.callDepth !== 64 ||
    !isRecord(value.toolchain) ||
    !exactKeys(value.toolchain, ["compiler", "binaryen", "typescript"]) ||
    Object.values(value.toolchain).some(
      (version) => typeof version !== "string" || !version,
    )
  )
    throw new Error("INVALID_ARTIFACT: invalid collection manifest");
  const sourcePaths = new Set<string>();
  for (const source of value.sources) {
    if (
      !isRecord(source) ||
      !exactKeys(source, ["path", "hash"]) ||
      !safePath(source.path) ||
      !HASH.test(source.hash) ||
      sourcePaths.has(source.path)
    )
      throw new Error("INVALID_ARTIFACT: invalid source inventory");
    sourcePaths.add(source.path);
  }
  const dependencies = new Set<string>();
  for (const dependency of value.dependencies) {
    if (
      !isRecord(dependency) ||
      !exactKeys(dependency, ["from", "to"]) ||
      !safePath(dependency.from) ||
      !safePath(dependency.to) ||
      dependencies.has(`${dependency.from}\0${dependency.to}`)
    )
      throw new Error("INVALID_ARTIFACT: invalid dependency inventory");
    dependencies.add(`${dependency.from}\0${dependency.to}`);
  }
  if (hasWasm !== value.targets.includes("wasm"))
    throw new Error("INVALID_ARTIFACT: inconsistent Wasm target");
  const root = dirname(absolute),
    artifactBytes = new Map<string, Uint8Array>();
  let total = 0;
  for (const item of value.artifacts) {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["path", "hash", "bytes"]) ||
      !safePath(item.path) ||
      !HASH.test(item.hash) ||
      !Number.isInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > 16 * 1024 * 1024 ||
      artifactBytes.has(item.path)
    )
      throw new Error("INVALID_ARTIFACT: invalid artifact inventory");
    const target = await resolveContainedFile(
        root,
        item.path,
        "collection artifact",
        { containmentLabel: "module bundle", rejectSymbolicLinks: true },
      ),
      bytes = await readFile(target);
    total += bytes.length;
    if (
      total > 32 * 1024 * 1024 ||
      bytes.length !== item.bytes ||
      digest(bytes) !== item.hash
    )
      throw new Error(`ARTIFACT_MISMATCH: ${item.path}`);
    artifactBytes.set(item.path, bytes);
  }
  const allowedArtifact = (artifactPath: string) =>
    (value.targets.includes("typescript") &&
      artifactPath === "typescript/program.generated.ts") ||
    (value.targets.includes("wasm") && artifactPath === "wasm/program.wasm") ||
    (value.targets.includes("jsonc") &&
      artifactPath.startsWith("jsonc/") &&
      artifactPath.endsWith(".llang.jsonc"));
  if (
    [...artifactBytes.keys()].some(
      (artifactPath) => !allowedArtifact(artifactPath),
    ) ||
    (value.targets.includes("typescript") &&
      !artifactBytes.has("typescript/program.generated.ts")) ||
    (value.targets.includes("wasm") &&
      !artifactBytes.has("wasm/program.wasm")) ||
    (value.targets.includes("jsonc") &&
      ![...artifactBytes.keys()].some(
        (artifactPath) =>
          artifactPath.startsWith("jsonc/") &&
          artifactPath.endsWith(".llang.jsonc"),
      ))
  )
    throw new Error("INVALID_ARTIFACT: inconsistent artifact targets");
  if (value.targets.includes("wasm")) {
    if (
      !value.wasm ||
      !isRecord(value.wasm) ||
      !exactKeys(value.wasm, ["path", "export", "contract", "wasmHash"]) ||
      value.wasm.path !== "wasm/program.wasm" ||
      value.wasm.export !== "evaluate" ||
      !HASH.test(value.wasm.wasmHash) ||
      digest(artifactBytes.get(value.wasm.path) ?? new Uint8Array()) !==
        value.wasm.wasmHash
    )
      throw new Error("ARTIFACT_MISMATCH: invalid Wasm inventory");
    assertCollectionWasmContract(value.wasm.contract);
    const wasmBytes = artifactBytes.get(value.wasm.path);
    if (!wasmBytes) throw new Error("ARTIFACT_MISMATCH: missing Wasm artifact");
    assertCollectionWasmBinary(wasmBytes);
    if (
      value.wasm.contract.programHash !== value.programHash ||
      value.wasm.contract.loweredHash !== value.loweredHash ||
      value.wasm.contract.layoutHash !== value.layoutHash
    )
      throw new Error("INVALID_ARTIFACT: inconsistent collection contract");
  }
  return { manifest: value, artifactBytes };
}
