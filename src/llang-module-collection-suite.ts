import {
  readFile,
  writeFile,
  mkdtemp,
  mkdir,
  rm,
  lstat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseStrictJsonObject } from "./llang-jsonc";
import {
  CollectionFault,
  evaluateCollectionProgram,
  type CollectionFaultCode,
} from "./llang-module-collection-evaluator";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import {
  emitCollectionModuleJsonc,
  emitCollectionModuleTypeScript,
} from "./llang-module-collection-source-emitter";
import { emitCollectionModuleWasm } from "./llang-module-collection-wasm";
import { instantiateCollectionModule } from "./llang-module-collection-runtime";
import { readCollectionModuleBuildManifest } from "./llang-module-collection-build";
import { encodeCollectionToMemory } from "./llang-collection-abi";
import type { CollectionType } from "./llang-module-collection-ir";

export type CollectionExpected =
  | { kind: "value"; value: unknown }
  | { kind: "invalid-input" }
  | { kind: "fault"; code: CollectionFaultCode };
export type CollectionModuleSuite = {
  format: "llang-module-suite";
  version: 3;
  profile: "module-collection-v1";
  interfaceHash: string;
  cases: { id: string; input: unknown; expected: CollectionExpected }[];
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const hasExactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
};
export function parseCollectionModuleSuite(
  value: unknown,
): CollectionModuleSuite {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "format",
      "version",
      "profile",
      "interfaceHash",
      "cases",
    ])
  )
    throw new Error("invalid collection suite");
  const suite = value as CollectionModuleSuite;
  if (
    !suite ||
    typeof suite !== "object" ||
    suite.format !== "llang-module-suite" ||
    suite.version !== 3 ||
    suite.profile !== "module-collection-v1" ||
    !/^[0-9a-f]{64}$/.test(suite.interfaceHash) ||
    !Array.isArray(suite.cases) ||
    !suite.cases.length ||
    suite.cases.length > 4096
  )
    throw new Error("invalid collection suite");
  const ids = new Set<string>();
  for (const item of suite.cases) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["id", "input", "expected"]) ||
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 256 ||
      ids.has(item.id) ||
      !isRecord(item.expected) ||
      !["value", "invalid-input", "fault"].includes(item.expected.kind)
    )
      throw new Error("invalid collection suite case");
    ids.add(item.id);
    if (
      (item.expected.kind === "value" &&
        !hasExactKeys(item.expected, ["kind", "value"])) ||
      (item.expected.kind === "invalid-input" &&
        !hasExactKeys(item.expected, ["kind"])) ||
      (item.expected.kind === "fault" &&
        !hasExactKeys(item.expected, ["kind", "code"]))
    )
      throw new Error("invalid collection suite expectation");
    if (
      item.expected.kind === "fault" &&
      ![
        "ARITHMETIC_OVERFLOW",
        "DIVISION_BY_ZERO",
        "RESOURCE_LIMIT",
        "INDEX_OUT_OF_BOUNDS",
        "INVALID_ARTIFACT",
      ].includes(item.expected.code)
    )
      throw new Error("invalid collection fault expectation");
  }
  return suite;
}
async function readCollectionModuleSuiteFile(
  path: string,
): Promise<CollectionModuleSuite> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
    throw new Error("invalid collection suite file");
  return parseCollectionModuleSuite(
    parseStrictJsonObject(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
      path,
    ),
  );
}
function validateExpectedValues(
  suite: CollectionModuleSuite,
  outputType: CollectionType,
): void {
  for (const item of suite.cases) {
    if (item.expected.kind !== "value") continue;
    try {
      encodeCollectionToMemory(
        new Uint8Array(262144),
        outputType,
        item.expected.value,
        0,
        262144,
      );
    } catch {
      throw new Error(`invalid collection suite expected value: ${item.id}`);
    }
  }
}
function outcome(run: () => unknown): CollectionExpected {
  try {
    return { kind: "value", value: run() };
  } catch (error) {
    if (error instanceof CollectionFault)
      return error.code === "INVALID_ARTIFACT"
        ? { kind: "invalid-input" }
        : { kind: "fault", code: error.code };
    const message = error instanceof Error ? error.message : String(error);
    const code = [
      "ARITHMETIC_OVERFLOW",
      "DIVISION_BY_ZERO",
      "RESOURCE_LIMIT",
      "INDEX_OUT_OF_BOUNDS",
      "INVALID_ARTIFACT",
    ].find((x) => message.includes(x)) as CollectionFaultCode | undefined;
    return code === "INVALID_ARTIFACT" || !code
      ? { kind: "invalid-input" }
      : { kind: "fault", code };
  }
}
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => same(value, b[index]))
    );
  if (!isRecord(a) || !isRecord(b)) return false;
  const leftKeys = Object.keys(a).sort();
  const rightKeys = Object.keys(b).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && same(a[key], b[key]),
    )
  );
}
export async function testCollectionModuleProgram(options: {
  entry: string;
  root: string;
  entryName: string;
  suite: string;
}): Promise<{
  ok: boolean;
  cases: {
    id: string;
    ok: boolean;
    results: Record<string, CollectionExpected>;
  }[];
}> {
  const program = await loadCollectionModuleProgram(
      options.entry,
      options.root,
      options.entryName,
    ),
    suite = await readCollectionModuleSuiteFile(options.suite);
  if (suite.interfaceHash !== program.interfaceHash)
    throw new Error("suite interfaceHash mismatch");
  validateExpectedValues(suite, program.entryOutput);
  const wasm = emitCollectionModuleWasm(program),
    instance = instantiateCollectionModule(wasm.contract, wasm.bytes),
    temp = await mkdtemp(join(tmpdir(), "llang-collection-suite-"));
  try {
    const generated = join(temp, "program.ts");
    await writeFile(generated, emitCollectionModuleTypeScript(program));
    const tsModule = await import(`${generated}?v=${Date.now()}`);
    const jsonRoot = join(temp, "jsonc");
    for (const [path, text] of emitCollectionModuleJsonc(program)) {
      const target = join(jsonRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    }
    const entryId = program.entry.slice(0, program.entry.lastIndexOf("#")),
      jsonProgram = await loadCollectionModuleProgram(
        `${entryId}.llang.jsonc`,
        jsonRoot,
        options.entryName,
      );
    const cases = suite.cases.map((item) => {
      const results = {
        reference: outcome(() =>
          evaluateCollectionProgram(program, item.input),
        ),
        typescript: outcome(() => tsModule.evaluate(item.input)),
        jsonc: outcome(() =>
          evaluateCollectionProgram(jsonProgram, item.input),
        ),
        wasm: outcome(() => instance.evaluate(item.input)),
      };
      return {
        id: item.id,
        ok: Object.values(results).every((x) => same(x, item.expected)),
        results,
      };
    });
    return { ok: cases.every((x) => x.ok), cases };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function verifyCollectionModuleBundle(
  manifestPath: string,
  suitePath: string,
): Promise<{ ok: boolean; cases: { id: string; ok: boolean }[] }> {
  const { manifest, artifactBytes } =
      await readCollectionModuleBuildManifest(manifestPath),
    suite = await readCollectionModuleSuiteFile(suitePath);
  if (!manifest.wasm || suite.interfaceHash !== manifest.interfaceHash)
    throw new Error(
      "portable collection verification requires matching Wasm suite",
    );
  validateExpectedValues(suite, manifest.wasm.contract.outputType);
  const wasmBytes = artifactBytes.get(manifest.wasm.path);
  if (!wasmBytes) throw new Error("missing collection Wasm artifact");
  const runtime = instantiateCollectionModule(
    manifest.wasm.contract,
    wasmBytes,
  );
  const cases = suite.cases.map((item) => ({
    id: item.id,
    ok: same(
      outcome(() => runtime.evaluate(item.input)),
      item.expected,
    ),
  }));
  return { ok: cases.every((x) => x.ok), cases };
}
