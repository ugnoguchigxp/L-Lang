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
import { canonicalValueType } from "./llang-module-value-ir";
import {
  loadValueModuleProgram,
  revalidateValueModuleSnapshot,
} from "./llang-module-value-loader";
import {
  emitValueModuleJsonc,
  emitValueModuleTypeScript,
} from "./llang-module-value-source-emitter";
import {
  emitValueModuleWasm,
  type ValueWasmContract,
} from "./llang-module-value-wasm";
import {
  assertValueWasmBinary,
  assertValueWasmContract,
} from "./llang-module-value-runtime";
import { fingerprintFor } from "./stable-hash";

export type ValueModuleTarget = "typescript" | "jsonc" | "wasm";
export type ValueModuleBuildManifest = {
  format: "llang-module-build";
  version: 2;
  profile: "module-value-v1";
  abi: "llang-value-memory-v1";
  entry: string;
  sourceSetHash: string;
  programHash: string;
  interfaceHash: string;
  layoutHash: string;
  resources: {
    memoryPages: 16;
    stringBytes: 16384;
    wireBytes: 65536;
    fuel: 100000;
  };
  sources: { path: string; hash: string }[];
  dependencies: { from: string; to: string }[];
  targets: ValueModuleTarget[];
  artifacts: { path: string; hash: string; bytes: number }[];
  wasm?: {
    path: string;
    export: "evaluate";
    contract: ValueWasmContract;
    wasmHash: string;
  };
  toolchain: { compiler: string; binaryen: string; typescript: string };
};
const HASH = /^[0-9a-f]{64}$/;
const ENTRY = /^[^#]+#[A-Za-z_$][A-Za-z0-9_$]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const compareAscii = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
function exactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((name) => expected.includes(name))
  );
}
function manifestPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}
async function writeArtifact(
  root: string,
  path: string,
  data: string | Uint8Array,
  output: ValueModuleBuildManifest["artifacts"],
): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, data);
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  output.push({ path, hash: digest(bytes), bytes: bytes.length });
}
export async function buildValueModuleProgram(options: {
  entry: string;
  root: string;
  entryName: string;
  target?: ValueModuleTarget | "all";
  outDir: string;
}): Promise<ValueModuleBuildManifest> {
  const program = await loadValueModuleProgram(
      options.entry,
      options.root,
      options.entryName,
    ),
    out = resolve(options.outDir);
  await mkdir(out);
  let owned = true;
  try {
    const targets: ValueModuleTarget[] =
        options.target && options.target !== "all"
          ? [options.target]
          : ["typescript", "jsonc", "wasm"],
      artifacts: ValueModuleBuildManifest["artifacts"] = [];
    if (targets.includes("typescript")) {
      const text = emitValueModuleTypeScript(program),
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
        }),
      );
      if (diagnostics.length)
        throw new Error(
          `generated TypeScript failed typecheck: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, "\n")}`,
        );
    }
    if (targets.includes("jsonc")) {
      for (const [path, text] of emitValueModuleJsonc(program))
        await writeArtifact(out, `jsonc/${path}`, text, artifacts);
      const entryId = program.entry.slice(0, program.entry.lastIndexOf("#")),
        roundTrip = await loadValueModuleProgram(
          `${entryId}.llang.jsonc`,
          join(out, "jsonc"),
          options.entryName,
        );
      if (
        roundTrip.programHash !== program.programHash ||
        roundTrip.interfaceHash !== program.interfaceHash ||
        roundTrip.layoutHash !== program.layoutHash
      )
        throw new Error("generated JSONC round-trip changed program meaning");
    }
    let wasm: ValueModuleBuildManifest["wasm"];
    if (targets.includes("wasm")) {
      const emitted = emitValueModuleWasm(program),
        path = "wasm/program.wasm",
        wasmHash = digest(emitted.bytes);
      assertValueWasmBinary(emitted.bytes);
      await writeArtifact(out, path, emitted.bytes, artifacts);
      wasm = { path, export: "evaluate", contract: emitted.contract, wasmHash };
    }
    await revalidateValueModuleSnapshot(program);
    const manifest: ValueModuleBuildManifest = {
      format: "llang-module-build",
      version: 2,
      profile: "module-value-v1",
      abi: "llang-value-memory-v1",
      entry: program.entry,
      sourceSetHash: program.sourceSetHash,
      programHash: program.programHash,
      interfaceHash: program.interfaceHash,
      layoutHash: program.layoutHash,
      resources: {
        memoryPages: 16,
        stringBytes: 16384,
        wireBytes: 65536,
        fuel: 100000,
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
      artifacts: artifacts.sort((a, b) => compareAscii(a.path, b.path)),
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
export async function readValueModuleBuildManifest(path: string): Promise<{
  manifest: ValueModuleBuildManifest;
  artifactBytes: Map<string, Uint8Array>;
}> {
  const absolute = resolve(path),
    info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error("INVALID_ARTIFACT: invalid value manifest file");
  const raw = await readFile(absolute),
    value = parseStrictJsonObject(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
      absolute,
    ) as ValueModuleBuildManifest;
  if (
    value.format !== "llang-module-build" ||
    value.version !== 2 ||
    value.profile !== "module-value-v1" ||
    value.abi !== "llang-value-memory-v1" ||
    !ENTRY.test(value.entry) ||
    !HASH.test(value.sourceSetHash) ||
    !HASH.test(value.programHash) ||
    !HASH.test(value.interfaceHash) ||
    !HASH.test(value.layoutHash) ||
    !Array.isArray(value.sources) ||
    !value.sources.length ||
    value.sources.length > 64 ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 1024 ||
    !Array.isArray(value.artifacts) ||
    !value.artifacts.length ||
    value.artifacts.length > 128 ||
    !Array.isArray(value.targets) ||
    !value.targets.length ||
    value.targets.length > 3 ||
    new Set(value.targets).size !== value.targets.length ||
    value.targets.some((x) => !["typescript", "jsonc", "wasm"].includes(x)) ||
    !value.resources ||
    typeof value.resources !== "object" ||
    !exactKeys(value.resources, [
      "memoryPages",
      "stringBytes",
      "wireBytes",
      "fuel",
    ]) ||
    value.resources.memoryPages !== 16 ||
    value.resources.stringBytes !== 16384 ||
    value.resources.wireBytes !== 65536 ||
    value.resources.fuel !== 100000 ||
    !value.toolchain ||
    typeof value.toolchain !== "object" ||
    !exactKeys(value.toolchain, ["compiler", "binaryen", "typescript"]) ||
    !VERSION.test(value.toolchain.compiler) ||
    !VERSION.test(value.toolchain.binaryen) ||
    !VERSION.test(value.toolchain.typescript)
  )
    throw new Error("INVALID_ARTIFACT: invalid value manifest");
  const allowed = new Set([
    "format",
    "version",
    "profile",
    "abi",
    "entry",
    "sourceSetHash",
    "programHash",
    "interfaceHash",
    "layoutHash",
    "resources",
    "sources",
    "dependencies",
    "targets",
    "artifacts",
    "wasm",
    "toolchain",
  ]);
  if (Object.keys(value).some((x) => !allowed.has(x)))
    throw new Error("INVALID_ARTIFACT: unknown value manifest field");
  const sourcePaths = new Set<string>();
  for (const source of value.sources)
    if (
      !source ||
      typeof source !== "object" ||
      !exactKeys(source, ["path", "hash"]) ||
      !manifestPath(source.path) ||
      !HASH.test(source.hash) ||
      sourcePaths.has(source.path)
    )
      throw new Error("INVALID_ARTIFACT: invalid source inventory");
    else sourcePaths.add(source.path);
  const sourceIds = new Set(
      [...sourcePaths].map((path) => path.replace(/\.llang\.jsonc$|\.ts$/, "")),
    ),
    sourceSetHash = fingerprintFor(
      value.sources.map((source) => ({
        id: source.path.replace(/\.llang\.jsonc$|\.ts$/, ""),
        sourceHash: source.hash,
      })),
    );
  if (
    sourceSetHash !== value.sourceSetHash ||
    !sourceIds.has(value.entry.slice(0, value.entry.lastIndexOf("#")))
  )
    throw new Error("INVALID_ARTIFACT: inconsistent source inventory");
  const dependencies = new Set<string>();
  for (const dependency of value.dependencies)
    if (
      !dependency ||
      typeof dependency !== "object" ||
      !exactKeys(dependency, ["from", "to"]) ||
      !manifestPath(dependency.from) ||
      !manifestPath(dependency.to) ||
      !sourceIds.has(dependency.from) ||
      !sourceIds.has(dependency.to) ||
      dependencies.has(`${dependency.from}\0${dependency.to}`)
    )
      throw new Error("INVALID_ARTIFACT: invalid dependency inventory");
    else dependencies.add(`${dependency.from}\0${dependency.to}`);
  const root = dirname(absolute),
    artifactBytes = new Map<string, Uint8Array>();
  let total = 0;
  for (const item of value.artifacts) {
    if (
      !item ||
      typeof item !== "object" ||
      !exactKeys(item, ["path", "hash", "bytes"]) ||
      !manifestPath(item.path) ||
      !HASH.test(item.hash) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > 16 * 1024 * 1024 ||
      artifactBytes.has(item.path)
    )
      throw new Error("INVALID_ARTIFACT: invalid artifact inventory");
    const target = await resolveContainedFile(
        root,
        item.path,
        "value artifact",
        { containmentLabel: "module bundle", rejectSymbolicLinks: true },
      ),
      bytes = await readFile(target);
    total += bytes.length;
    if (
      total > 16 * 1024 * 1024 ||
      bytes.length !== item.bytes ||
      digest(bytes) !== item.hash
    )
      throw new Error(`ARTIFACT_MISMATCH: ${item.path}`);
    artifactBytes.set(item.path, bytes);
  }
  const artifactPaths = [...artifactBytes.keys()],
    typescriptArtifacts = artifactPaths.filter((x) =>
      x.startsWith("typescript/"),
    ),
    jsoncArtifacts = artifactPaths.filter((x) => x.startsWith("jsonc/")),
    wasmArtifacts = artifactPaths.filter((x) => x.startsWith("wasm/"));
  if (
    artifactPaths.some(
      (x) =>
        !x.startsWith("typescript/") &&
        !x.startsWith("jsonc/") &&
        !x.startsWith("wasm/"),
    ) ||
    (value.targets.includes("typescript")
      ? typescriptArtifacts.length !== 1 ||
        typescriptArtifacts[0] !== "typescript/program.generated.ts"
      : typescriptArtifacts.length !== 0) ||
    (value.targets.includes("jsonc")
      ? !jsoncArtifacts.length ||
        jsoncArtifacts.some((x) => !x.endsWith(".llang.jsonc"))
      : jsoncArtifacts.length !== 0) ||
    (value.targets.includes("wasm")
      ? wasmArtifacts.length !== 1 || wasmArtifacts[0] !== "wasm/program.wasm"
      : wasmArtifacts.length !== 0) ||
    value.targets.includes("wasm") !== Boolean(value.wasm)
  )
    throw new Error("INVALID_ARTIFACT: inconsistent target inventory");
  if (value.wasm) {
    if (
      typeof value.wasm !== "object" ||
      !exactKeys(value.wasm, ["path", "export", "contract", "wasmHash"]) ||
      value.wasm.path !== "wasm/program.wasm" ||
      value.wasm.export !== "evaluate" ||
      !HASH.test(value.wasm.wasmHash) ||
      value.wasm.wasmHash !==
        digest(artifactBytes.get(value.wasm.path) ?? new Uint8Array())
    )
      throw new Error("ARTIFACT_MISMATCH: invalid Wasm inventory");
    const contract = assertValueWasmContract(value.wasm.contract),
      interfaceHash = fingerprintFor({
        profile: "module-value-v1",
        input: canonicalValueType(contract.inputType),
        output: canonicalValueType(contract.outputType),
      });
    if (
      value.wasm.contract.layoutHash !== value.layoutHash ||
      interfaceHash !== value.interfaceHash
    )
      throw new Error("INVALID_ARTIFACT: inconsistent Wasm contract");
    assertValueWasmBinary(artifactBytes.get(value.wasm.path)!);
  }
  return { manifest: value, artifactBytes };
}
