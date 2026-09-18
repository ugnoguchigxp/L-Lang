import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  emitLinearEffectsWasm,
  type LinearHostRequest,
  replayLinearEffects,
} from "./llang-effects-wasm";
import { parseStrictJsonObject } from "./llang-jsonc";
import {
  type EffectsModuleBuildManifest,
  readEffectsModuleBuildManifest,
} from "./llang-module-effects-build";
import { loadEffectsModuleProgram } from "./llang-module-effects-loader";

export type EffectsModuleSuite = Readonly<{
  format: "llang-module-suite";
  version: 5;
  profile: "module-effects-v1";
  interfaceHash: string;
  cases: readonly Readonly<{
    id: string;
    events: readonly Readonly<{
      request: LinearHostRequest;
      response: Readonly<{ ok: boolean; value: number }>;
    }>[];
    expected: number;
  }>[];
}>;

const HASH = /^[0-9a-f]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const i32 = (value: unknown) =>
  Number.isInteger(value) &&
  Number(value) >= -2147483648 &&
  Number(value) <= 2147483647;

export function parseEffectsModuleSuite(value: unknown): EffectsModuleSuite {
  if (
    !object(value) ||
    !exact(value, ["format", "version", "profile", "interfaceHash", "cases"]) ||
    value.format !== "llang-module-suite" ||
    value.version !== 5 ||
    value.profile !== "module-effects-v1" ||
    !HASH.test(String(value.interfaceHash)) ||
    !Array.isArray(value.cases) ||
    !value.cases.length ||
    value.cases.length > 1024
  )
    throw new Error("INVALID_EFFECTS_SUITE");
  const ids = new Set<string>();
  for (const item of value.cases) {
    if (
      !object(item) ||
      !exact(item, ["id", "events", "expected"]) ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      !Array.isArray(item.events) ||
      item.events.length > 1024 ||
      !i32(item.expected)
    )
      throw new Error("INVALID_EFFECTS_SUITE");
    ids.add(item.id);
    for (const event of item.events) {
      if (
        !object(event) ||
        !exact(event, ["request", "response"]) ||
        !object(event.request) ||
        !exact(event.request, [
          "generation",
          "sequence",
          "operation",
          "payload",
        ]) ||
        !Number.isInteger(event.request.generation) ||
        Number(event.request.generation) < 0 ||
        !Number.isInteger(event.request.sequence) ||
        Number(event.request.sequence) < 1 ||
        !Number.isInteger(event.request.operation) ||
        Number(event.request.operation) < 0 ||
        !i32(event.request.payload) ||
        !object(event.response) ||
        !exact(event.response, ["ok", "value"]) ||
        typeof event.response.ok !== "boolean" ||
        !i32(event.response.value)
      )
        throw new Error("INVALID_EFFECTS_SUITE_EVENT");
    }
  }
  return value as unknown as EffectsModuleSuite;
}

export async function readEffectsModuleSuite(
  path: string,
): Promise<EffectsModuleSuite> {
  const absolute = resolve(path),
    info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error("INVALID_EFFECTS_SUITE_FILE");
  return parseEffectsModuleSuite(
    parseStrictJsonObject(await readFile(absolute, "utf8"), absolute),
  );
}

const run = (
  bytes: Uint8Array,
  suite: EffectsModuleSuite,
): readonly Readonly<{
  id: string;
  ok: boolean;
  actual?: number;
  error?: string;
}>[] =>
  Object.freeze(
    suite.cases.map((item) => {
      try {
        const actual = replayLinearEffects(bytes, item.events).result;
        return Object.freeze({
          id: item.id,
          ok: actual === item.expected,
          actual,
        });
      } catch (error) {
        return Object.freeze({
          id: item.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

export async function testEffectsModuleProgram(options: {
  entry: string;
  root: string;
  entryName: string;
  suite: string;
}): Promise<{
  ok: boolean;
  programHash: string;
  interfaceHash: string;
  cases: ReturnType<typeof run>;
}> {
  const program = await loadEffectsModuleProgram(
      options.entry,
      options.root,
      options.entryName,
    ),
    suite = await readEffectsModuleSuite(options.suite);
  if (suite.interfaceHash !== program.interfaceHash)
    throw new Error("EFFECTS_SUITE_INTERFACE_MISMATCH");
  const cases = run(emitLinearEffectsWasm(program.program).bytes, suite);
  return {
    ok: cases.every((item) => item.ok),
    programHash: program.programHash,
    interfaceHash: program.interfaceHash,
    cases,
  };
}

export async function verifyEffectsModuleBundle(
  manifestPath: string,
  suitePath: string,
): Promise<{
  ok: boolean;
  manifest: EffectsModuleBuildManifest;
  cases: ReturnType<typeof run>;
}> {
  const { manifest, artifacts } =
      await readEffectsModuleBuildManifest(manifestPath),
    suite = await readEffectsModuleSuite(suitePath);
  if (suite.interfaceHash !== manifest.interfaceHash)
    throw new Error("EFFECTS_SUITE_INTERFACE_MISMATCH");
  if (!manifest.wasm) throw new Error("INVALID_ARTIFACT: missing effects Wasm");
  const bytes = artifacts.get(manifest.wasm.path);
  if (!bytes) throw new Error("INVALID_ARTIFACT: missing effects Wasm");
  const cases = run(bytes, suite);
  return { ok: cases.every((item) => item.ok), manifest, cases };
}
