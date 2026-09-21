import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CheckedCollectionProgram } from "./llang-module-collection-ir";
import { parseStrictJsonObject } from "./llang-jsonc";
import { assertCollectionWasmBinary } from "./llang-module-collection-runtime";
import { emitUnoptimizedCollectionModuleWasm } from "./llang-module-collection-wasm";
import {
  canonicalCollectionBinaryenRecipe,
  collectionBinaryenRecipeHash,
  parseCollectionBinaryenRecipe,
  type CollectionBinaryenRecipe,
} from "./llang-collection-binaryen-recipe";

const MAX_OUTPUT = 64 * 1024;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export type OptimizedCollectionWasm = Readonly<{
  bytes: Uint8Array;
  baselineHash: string;
  wasmHash: string;
  recipe: CollectionBinaryenRecipe;
  recipeHash: string;
  optimizeMs: number;
  phases: Readonly<{
    readMs: number;
    preValidationMs: number;
    optimizeMs: number;
    postValidationMs: number;
    emitMs: number;
  }>;
}>;

const zeroPhases = () =>
  Object.freeze({
    readMs: 0,
    preValidationMs: 0,
    optimizeMs: 0,
    postValidationMs: 0,
    emitMs: 0,
  });

export async function optimizeCollectionWasm(
  baseline: Uint8Array,
  recipeInput: CollectionBinaryenRecipe,
  options: Readonly<{ timeoutMs?: number; temporaryParent?: string }> = {},
): Promise<OptimizedCollectionWasm> {
  const recipe = parseCollectionBinaryenRecipe(recipeInput);
  assertCollectionWasmBinary(baseline);
  const baselineHash = hash(baseline),
    recipeHash = collectionBinaryenRecipeHash(recipe);
  if (recipe.recipeId === "baseline-v1") {
    const bytes = new Uint8Array(baseline);
    return Object.freeze({
      bytes,
      baselineHash,
      wasmHash: baselineHash,
      recipe,
      recipeHash,
      optimizeMs: 0,
      phases: zeroPhases(),
    });
  }

  const parent = options.temporaryParent
      ? resolve(options.temporaryParent)
      : tmpdir(),
    root = await mkdtemp(join(parent, "llang-collection-optimize-"));
  try {
    const input = join(root, "input.wasm"),
      recipePath = join(root, "recipe.json"),
      output = join(root, "output.wasm"),
      timing = join(root, "timing.json");
    await Promise.all([
      writeFile(input, baseline, { flag: "wx", mode: 0o600 }),
      writeFile(recipePath, `${canonicalCollectionBinaryenRecipe(recipe)}\n`, {
        flag: "wx",
        mode: 0o600,
      }),
    ]);
    const started = performance.now(),
      child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "llang-collection-optimize-child.ts"),
          input,
          recipePath,
          output,
          timing,
        ],
        {
          cwd: root,
          env: process.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);
    let stdout: Uint8Array, stderr: Uint8Array, exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        readBounded(child.stdout, MAX_OUTPUT),
        readBounded(child.stderr, MAX_OUTPUT),
        child.exited,
      ]);
    } catch (error) {
      child.kill("SIGKILL");
      await child.exited;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw new Error("COLLECTION_OPTIMIZER_TIMEOUT");
    if (exitCode !== 0)
      throw new Error(
        `COLLECTION_OPTIMIZER_FAILED: ${new TextDecoder().decode(stderr).slice(0, 4096)}`,
      );
    if (stdout.length)
      throw new Error("COLLECTION_OPTIMIZER_PROTOCOL: unexpected stdout");
    const [info, timingInfo] = await Promise.all([
      lstat(output).catch(() => undefined),
      lstat(timing).catch(() => undefined),
    ]);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw new Error("COLLECTION_OPTIMIZER_OUTPUT: invalid output file");
    if (
      !timingInfo?.isFile() ||
      timingInfo.isSymbolicLink() ||
      timingInfo.size > 16 * 1024
    )
      throw new Error("COLLECTION_OPTIMIZER_OUTPUT: invalid timing file");
    const [outputBytes, timingText] = await Promise.all([
        readFile(output),
        readFile(timing, "utf8"),
      ]),
      bytes = new Uint8Array(outputBytes),
      phases = parseOptimizerPhases(parseStrictJsonObject(timingText, timing));
    assertCollectionWasmBinary(bytes);
    return Object.freeze({
      bytes,
      baselineHash,
      wasmHash: hash(bytes),
      recipe,
      recipeHash,
      optimizeMs: performance.now() - started,
      phases,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseOptimizerPhases(
  candidate: unknown,
): OptimizedCollectionWasm["phases"] {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("COLLECTION_OPTIMIZER_PROTOCOL: invalid phases");
  const value = candidate as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !==
      "emitMs,optimizeMs,postValidationMs,preValidationMs,readMs" ||
    Object.values(value).some(
      (item) => typeof item !== "number" || !Number.isFinite(item) || item < 0,
    )
  )
    throw new Error("COLLECTION_OPTIMIZER_PROTOCOL: invalid phases");
  return Object.freeze({
    readMs: value.readMs as number,
    preValidationMs: value.preValidationMs as number,
    optimizeMs: value.optimizeMs as number,
    postValidationMs: value.postValidationMs as number,
    emitMs: value.emitMs as number,
  });
}

export async function emitOptimizedCollectionModuleWasm(
  program: CheckedCollectionProgram,
  recipe: CollectionBinaryenRecipe,
): Promise<
  ReturnType<typeof emitUnoptimizedCollectionModuleWasm> & {
    optimization: OptimizedCollectionWasm;
  }
> {
  const baseline = emitUnoptimizedCollectionModuleWasm(program),
    optimization = await optimizeCollectionWasm(baseline.bytes, recipe);
  return {
    ...baseline,
    bytes: optimization.bytes,
    optimization,
  };
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) throw new Error("COLLECTION_OPTIMIZER_OUTPUT_LIMIT");
    chunks.push(chunk);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
