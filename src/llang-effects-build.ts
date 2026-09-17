import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { digest } from "./wasm-contract";
import {
  assertEffectsWasm,
  emitLinearEffectsWasm,
  replayLinearEffects,
  type EffectsWasmContract,
  type LinearEffectsProgram,
  type LinearHostRequest,
} from "./llang-effects-wasm";
import type { EffectsManifest } from "./llang-effects-contract";
import { parseStrictJsonObject } from "./llang-jsonc";
import { resolveContainedFile } from "./contained-path";

export type EffectsBuildManifest = Readonly<{
  format: "llang-effects-build";
  version: 5;
  profile: "module-effects-v1";
  abi: "llang-effects-session-v1";
  programHash: string;
  operations: EffectsManifest["operations"];
  effects: EffectsManifest["effects"];
  wasm: Readonly<{
    path: "program.wasm";
    hash: string;
    bytes: number;
    contract: EffectsWasmContract;
  }>;
}>;
export type EffectsReplaySuite = Readonly<{
  format: "llang-effects-suite";
  version: 5;
  profile: "module-effects-v1";
  programHash: string;
  cases: readonly Readonly<{
    id: string;
    events: readonly Readonly<{
      request: LinearHostRequest;
      response: { ok: boolean; value: number };
    }>[];
    expected: number;
  }>[];
}>;

const HASH = /^[0-9a-f]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every((key) => expected.includes(key));

export async function buildEffectsProgram(options: {
  program: LinearEffectsProgram;
  manifest: EffectsManifest;
  outDir: string;
}): Promise<EffectsBuildManifest> {
  if (
    options.manifest.profile !== "module-effects-v1" ||
    options.manifest.abi !== "llang-effects-session-v1"
  )
    throw new Error("INVALID_EFFECTS_MANIFEST");
  const out = resolve(options.outDir);
  await mkdir(out);
  let owned = true;
  try {
    const emitted = emitLinearEffectsWasm(options.program),
      wasmHash = digest(emitted.bytes),
      manifest: EffectsBuildManifest = Object.freeze({
        format: "llang-effects-build",
        version: 5,
        profile: "module-effects-v1",
        abi: "llang-effects-session-v1",
        programHash: emitted.contract.programHash,
        operations: options.manifest.operations,
        effects: options.manifest.effects,
        wasm: Object.freeze({
          path: "program.wasm",
          hash: wasmHash,
          bytes: emitted.bytes.length,
          contract: emitted.contract,
        }),
      });
    await writeFile(join(out, "program.wasm"), emitted.bytes, { flag: "wx" });
    await writeFile(
      join(out, ".effects-build.json.tmp"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await rename(
      join(out, ".effects-build.json.tmp"),
      join(out, "effects-build.json"),
    );
    owned = false;
    return manifest;
  } catch (error) {
    if (owned) await rm(out, { recursive: true, force: true });
    throw error;
  }
}

export async function readEffectsBuild(path: string): Promise<{
  manifest: EffectsBuildManifest;
  bytes: Uint8Array;
}> {
  const absolute = resolve(path),
    info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error("INVALID_ARTIFACT: effects manifest file");
  const parsed = parseStrictJsonObject(
    await readFile(absolute, "utf8"),
    absolute,
  );
  if (
    !object(parsed) ||
    !keys(parsed, [
      "format",
      "version",
      "profile",
      "abi",
      "programHash",
      "operations",
      "effects",
      "wasm",
    ]) ||
    parsed.format !== "llang-effects-build" ||
    parsed.version !== 5 ||
    parsed.profile !== "module-effects-v1" ||
    parsed.abi !== "llang-effects-session-v1" ||
    typeof parsed.programHash !== "string" ||
    !HASH.test(parsed.programHash) ||
    !Array.isArray(parsed.operations) ||
    !Array.isArray(parsed.effects) ||
    !object(parsed.wasm) ||
    !keys(parsed.wasm, ["path", "hash", "bytes", "contract"]) ||
    parsed.wasm.path !== "program.wasm" ||
    typeof parsed.wasm.hash !== "string" ||
    !HASH.test(parsed.wasm.hash) ||
    !Number.isInteger(parsed.wasm.bytes) ||
    Number(parsed.wasm.bytes) < 0 ||
    !object(parsed.wasm.contract) ||
    !keys(parsed.wasm.contract, [
      "abi",
      "memory",
      "requestBytes",
      "eventBytes",
      "outputBytes",
      "programHash",
    ]) ||
    parsed.wasm.contract.abi !== "llang-effects-session-v1" ||
    parsed.wasm.contract.programHash !== parsed.programHash ||
    !object(parsed.wasm.contract.memory) ||
    !keys(parsed.wasm.contract.memory, ["initial", "maximum"]) ||
    parsed.wasm.contract.memory.initial !== 512 ||
    parsed.wasm.contract.memory.maximum !== 512 ||
    parsed.wasm.contract.requestBytes !== 16 ||
    parsed.wasm.contract.eventBytes !== 16 ||
    parsed.wasm.contract.outputBytes !== 4 ||
    parsed.operations.length > 1024 ||
    parsed.effects.length > 4 ||
    parsed.operations.some(
      (item) =>
        !object(item) ||
        !keys(item, ["id", "version", "signatureHash", "effect"]) ||
        typeof item.id !== "string" ||
        !Number.isInteger(item.version) ||
        typeof item.signatureHash !== "string" ||
        !HASH.test(item.signatureHash) ||
        !["file", "http", "clock", "host"].includes(String(item.effect)),
    ) ||
    parsed.effects.some(
      (effect) => !["file", "http", "clock", "host"].includes(String(effect)),
    )
  )
    throw new Error("INVALID_ARTIFACT: effects manifest");
  const manifest = parsed as unknown as EffectsBuildManifest,
    wasmPath = await resolveContainedFile(
      dirname(absolute),
      "program.wasm",
      "effects Wasm",
      { containmentLabel: "effects bundle", rejectSymbolicLinks: true },
    ),
    file = await readFile(wasmPath),
    bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  if (
    bytes.length !== manifest.wasm.bytes ||
    digest(bytes) !== manifest.wasm.hash
  )
    throw new Error("ARTIFACT_MISMATCH: program.wasm");
  assertEffectsWasm(bytes);
  return { manifest, bytes };
}

export async function verifyEffectsBundle(
  manifestPath: string,
  suite: EffectsReplaySuite,
): Promise<{ ok: boolean; cases: readonly { id: string; ok: boolean }[] }> {
  const { manifest, bytes } = await readEffectsBuild(manifestPath);
  if (
    suite.format !== "llang-effects-suite" ||
    suite.version !== 5 ||
    suite.profile !== "module-effects-v1" ||
    suite.programHash !== manifest.programHash ||
    !suite.cases.length ||
    new Set(suite.cases.map((item) => item.id)).size !== suite.cases.length
  )
    throw new Error("INVALID_EFFECTS_SUITE");
  const cases = suite.cases.map((item) => ({
    id: item.id,
    ok: replayLinearEffects(bytes, item.events).result === item.expected,
  }));
  return { ok: cases.every((item) => item.ok), cases: Object.freeze(cases) };
}
