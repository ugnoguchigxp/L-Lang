import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import type { CollectionModuleSource } from "./llang-module-collection-ir";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { instantiateCollectionModule } from "./llang-module-collection-runtime";
import {
  emitCollectionModuleJsonc,
  emitCollectionModuleTypeScript,
} from "./llang-module-collection-source-emitter";
import { collectionModuleSourceJson } from "./llang-module-collection-source-json";
import { emitCollectionModuleWasm } from "./llang-module-collection-wasm";
import { sha256 } from "./stable-hash";

export type CollectionDifferentialValue =
  | null
  | boolean
  | number
  | string
  | readonly CollectionDifferentialValue[]
  | Readonly<{ [key: string]: CollectionDifferentialValue }>;

export type CollectionDifferentialFaultCode =
  | "ARITHMETIC_OVERFLOW"
  | "DIVISION_BY_ZERO"
  | "INDEX_OUT_OF_BOUNDS";

export type CollectionDifferentialOutcome =
  | Readonly<{ kind: "value"; value: CollectionDifferentialValue }>
  | Readonly<{ kind: "fault"; code: CollectionDifferentialFaultCode }>;

export type CollectionDifferentialOutcomes = Readonly<{
  oracle: CollectionDifferentialOutcome;
  reference: CollectionDifferentialOutcome;
  typescript: CollectionDifferentialOutcome;
  jsonc: CollectionDifferentialOutcome;
  wasm: CollectionDifferentialOutcome;
}>;

export type CollectionDifferentialHashes = Readonly<{
  programHash: string;
  interfaceHash: string;
  wasmHash: string;
}>;

export type CollectionDifferentialHarnessStage =
  | "source-load"
  | "typescript"
  | "jsonc-round-trip"
  | "wasm"
  | "input-lanes";

export class CollectionDifferentialHarnessError extends Error {
  constructor(
    readonly stage: CollectionDifferentialHarnessStage,
    readonly inputIndex: number | undefined,
    cause: unknown,
  ) {
    super(
      `collection differential ${stage} failed${inputIndex === undefined ? "" : ` at input ${inputIndex}`}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "CollectionDifferentialHarnessError";
  }
}

export const COLLECTION_DIFFERENTIAL_LANES = [
  "oracle",
  "reference",
  "typescript",
  "jsonc",
  "wasm",
] as const;

const FAULT_CODES = new Set<CollectionDifferentialFaultCode>([
  "ARITHMETIC_OVERFLOW",
  "DIVISION_BY_ZERO",
  "INDEX_OUT_OF_BOUNDS",
]);

async function harnessStage<T>(
  stage: CollectionDifferentialHarnessStage,
  run: () => T | Promise<T>,
  inputIndex?: number,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CollectionDifferentialHarnessError) throw error;
    throw new CollectionDifferentialHarnessError(stage, inputIndex, error);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function collectionValue(
  value: unknown,
  seen = new WeakSet<object>(),
): CollectionDifferentialValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") {
    if (
      !Number.isInteger(value) ||
      value < -2_147_483_648 ||
      value > 2_147_483_647
    )
      throw new Error("collection differential lane returned a non-i32 number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value))
      throw new Error("collection differential lane returned a cyclic array");
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key))
          return true;
        const index = Number(key),
          descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          !Number.isSafeInteger(index) ||
          index >= value.length ||
          !descriptor ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        );
      }) ||
      Array.from({ length: value.length }, (_, index) => index).some(
        (index) => !Object.hasOwn(value, index),
      )
    )
      throw new Error("collection differential lane returned a non-JSON array");
    seen.add(value);
    const result = value.map((item) => collectionValue(item, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  if (!isPlainRecord(value))
    throw new Error("collection differential lane returned a non-plain value");
  if (seen.has(value))
    throw new Error("collection differential lane returned a cyclic record");
  seen.add(value);
  const result: Record<string, CollectionDifferentialValue> =
    Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      throw new Error(
        "collection differential lane returned a non-JSON record",
      );
    result[key] = collectionValue(descriptor.value, seen);
  }
  seen.delete(value);
  return Object.freeze(result);
}

function faultCode(
  error: unknown,
): CollectionDifferentialFaultCode | undefined {
  const direct =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  if (direct && FAULT_CODES.has(direct as CollectionDifferentialFaultCode))
    return direct as CollectionDifferentialFaultCode;
  const message = error instanceof Error ? error.message : String(error);
  return FAULT_CODES.has(message as CollectionDifferentialFaultCode)
    ? (message as CollectionDifferentialFaultCode)
    : undefined;
}

export function captureCollectionDifferentialOutcome(
  run: () => unknown,
): CollectionDifferentialOutcome {
  try {
    return Object.freeze({ kind: "value", value: collectionValue(run()) });
  } catch (error) {
    const code = faultCode(error);
    if (code) return Object.freeze({ kind: "fault", code });
    throw error;
  }
}

export function sameCollectionDifferentialOutcome(
  left: CollectionDifferentialOutcome,
  right: CollectionDifferentialOutcome,
): boolean {
  if (left.kind === "fault")
    return right.kind === "fault" && left.code === right.code;
  if (right.kind !== "value") return false;
  return sameCollectionValue(left.value, right.value);
}

function sameCollectionValue(
  left: CollectionDifferentialValue,
  right: CollectionDifferentialValue,
): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) =>
        sameCollectionValue(item, right[index] as CollectionDifferentialValue),
      )
    );
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(),
    rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameCollectionValue(
          left[key] as CollectionDifferentialValue,
          right[key] as CollectionDifferentialValue,
        ),
    )
  );
}

export function assertFiveCollectionDifferentialLanes(
  outcomes: CollectionDifferentialOutcomes,
): void {
  const keys = Object.keys(outcomes);
  if (
    keys.length !== COLLECTION_DIFFERENTIAL_LANES.length ||
    COLLECTION_DIFFERENTIAL_LANES.some((lane) => !Object.hasOwn(outcomes, lane))
  )
    throw new Error(
      "collection differential outcomes must contain all five lanes",
    );
}

function parseTypeScriptOutcomes(
  text: string,
  expectedLength: number,
): readonly CollectionDifferentialOutcome[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length !== expectedLength)
    throw new Error(
      "generated Collection TypeScript returned an invalid outcome list",
    );
  return Object.freeze(
    parsed.map((item) => {
      if (!isPlainRecord(item))
        throw new Error(
          "generated Collection TypeScript returned an invalid outcome",
        );
      if (item.kind === "value")
        return Object.freeze({
          kind: "value" as const,
          value: collectionValue(item.value),
        });
      if (
        item.kind === "fault" &&
        typeof item.code === "string" &&
        FAULT_CODES.has(item.code as CollectionDifferentialFaultCode)
      )
        return Object.freeze({
          kind: "fault" as const,
          code: item.code as CollectionDifferentialFaultCode,
        });
      if (item.kind === "runner-error" && typeof item.message === "string")
        throw new Error(
          `generated Collection TypeScript failed: ${item.message}`,
        );
      throw new Error(
        "generated Collection TypeScript returned an unknown outcome",
      );
    }),
  );
}

async function runGeneratedTypeScript(
  root: string,
  inputs: readonly unknown[],
): Promise<readonly CollectionDifferentialOutcome[]> {
  const inputsPath = join(root, "inputs.json"),
    runnerPath = join(root, "typescript-runner.ts");
  await writeFile(inputsPath, `${JSON.stringify(inputs)}\n`);
  await writeFile(
    runnerPath,
    `import { evaluate } from "./program.generated";
const inputs = await Bun.file(process.argv[2]!).json() as unknown[];
const faults = ["ARITHMETIC_OVERFLOW", "DIVISION_BY_ZERO", "INDEX_OUT_OF_BOUNDS"];
const outcomes = inputs.map((input) => {
  try {
    return { kind: "value", value: evaluate(input as never) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = faults.find((item) => message === item);
    return code
      ? { kind: "fault", code }
      : { kind: "runner-error", message };
  }
});
process.stdout.write(JSON.stringify(outcomes));
`,
  );
  const child = Bun.spawn([process.execPath, "run", runnerPath, inputsPath], {
    cwd: root,
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 5_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0)
      throw new Error(
        timedOut
          ? "generated Collection TypeScript execution timed out"
          : `generated Collection TypeScript execution failed: ${stderr.slice(0, 2_000)}`,
      );
    return parseTypeScriptOutcomes(stdout, inputs.length);
  } finally {
    clearTimeout(timeout);
  }
}

export async function runCollectionDifferentialLanes(options: {
  source: CollectionModuleSource;
  inputs: readonly unknown[];
  oracle: (input: unknown, inputIndex: number) => unknown;
  assertOutcomes: (
    inputIndex: number,
    outcomes: CollectionDifferentialOutcomes,
    hashes: CollectionDifferentialHashes,
  ) => void;
  temporaryPrefix: string;
}): Promise<
  Readonly<{
    programHash: string;
    interfaceHash: string;
    wasmHash: string;
    inputs: number;
  }>
> {
  const root = await mkdtemp(join(tmpdir(), options.temporaryPrefix));
  try {
    const sourcePath = join(root, "main.llang.jsonc");
    const program = await harnessStage("source-load", async () => {
        await writeFile(
          sourcePath,
          `${JSON.stringify(collectionModuleSourceJson(options.source), null, 2)}\n`,
        );
        return loadCollectionModuleProgram(
          "main.llang.jsonc",
          root,
          "evaluate",
        );
      }),
      typescriptOutcomes = await harnessStage("typescript", async () => {
        const generatedPath = join(root, "program.generated.ts");
        await writeFile(generatedPath, emitCollectionModuleTypeScript(program));
        return runGeneratedTypeScript(root, options.inputs);
      }),
      roundTrip = await harnessStage("jsonc-round-trip", async () => {
        const jsonRoot = join(root, "round-trip");
        for (const [path, source] of emitCollectionModuleJsonc(program)) {
          const target = join(jsonRoot, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, source);
        }
        const entryId = program.entry.slice(0, program.entry.lastIndexOf("#")),
          loaded = await loadCollectionModuleProgram(
            `${entryId}.llang.jsonc`,
            jsonRoot,
            "evaluate",
          );
        if (
          loaded.programHash !== program.programHash ||
          loaded.interfaceHash !== program.interfaceHash
        )
          throw new Error(
            "collection differential JSONC round-trip hash mismatch",
          );
        return loaded;
      }),
      wasm = await harnessStage("wasm", () => {
        const emitted = emitCollectionModuleWasm(program);
        return {
          emitted,
          runtime: instantiateCollectionModule(emitted.contract, emitted.bytes),
        };
      }),
      hashes = Object.freeze({
        programHash: program.programHash,
        interfaceHash: program.interfaceHash,
        wasmHash: sha256(wasm.emitted.bytes),
      });
    for (const [inputIndex, input] of options.inputs.entries()) {
      const typescript = typescriptOutcomes[inputIndex];
      if (!typescript)
        throw new Error("generated Collection TypeScript outcome is missing");
      const outcomes = await harnessStage(
        "input-lanes",
        () =>
          Object.freeze({
            oracle: captureCollectionDifferentialOutcome(() =>
              options.oracle(input, inputIndex),
            ),
            reference: captureCollectionDifferentialOutcome(() =>
              evaluateCollectionProgram(program, input),
            ),
            typescript,
            jsonc: captureCollectionDifferentialOutcome(() =>
              evaluateCollectionProgram(roundTrip, input),
            ),
            wasm: captureCollectionDifferentialOutcome(() =>
              wasm.runtime.evaluate(input),
            ),
          }),
        inputIndex,
      );
      options.assertOutcomes(inputIndex, outcomes, hashes);
    }
    return Object.freeze({
      ...hashes,
      inputs: options.inputs.length,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
