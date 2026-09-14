import { atomicWriteJson } from "./atomic-file";
import { parseElaborationResult } from "./elaboration-result";
import { type PredicateExpression, parsePredicateExpression } from "./ir";
import {
  contentHash,
  exampleInput,
  fail,
  type PromptSource,
  readJson,
  readPromptSource,
  sourceTransaction,
  stringValue,
} from "./prompt-source";
import { record, WasmError } from "./wasm-contract";
import { lowerPredicate } from "./wasm-core";

export const RESOLUTION_PROTOCOL = "prompt-predicate-v1";
export type ResolverReply = {
  result: unknown;
  provider: string;
  model: string;
  responseId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
};
export type ResolutionInput = Omit<PromptSource, "examples">;
export type PromptResolver = (
  source: ResolutionInput,
) => Promise<ResolverReply>;
export type ResolutionLock = {
  version: 1;
  protocol: typeof RESOLUTION_PROTOCOL;
  sourceHash: string;
  irHash: string;
  body: PredicateExpression;
  resolver: Omit<ResolverReply, "result">;
  diagnostics: string[];
  checksum: string;
};
export function resolutionInput(source: PromptSource): ResolutionInput {
  const { examples: _examples, ...input } = source;
  return input;
}
// Deliberately interprets Predicate IR, not lowered slots or emitted Wasm.
export function evaluatePromptIR(
  e: PredicateExpression,
  input: Record<string, unknown>,
): boolean {
  if (e.kind === "all")
    return e.conditions.every((c) => evaluatePromptIR(c, input));
  if (e.kind === "any")
    return e.conditions.some((c) => evaluatePromptIR(c, input));
  if (e.kind === "not") return !evaluatePromptIR(e.condition, input);
  if (!("property" in e) || e.property.length !== 1) fail("unsupported path");
  const value = input[e.property[0] as string];
  return e.kind === "present"
    ? value !== undefined && value !== null
    : value === e.value;
}
export function verifyExamples(
  source: PromptSource,
  body: PredicateExpression,
) {
  lowerPredicate(body, source.contract);
  const results = source.examples.map((e) => ({
    id: e.id,
    expected: e.expected,
    actual: evaluatePromptIR(body, exampleInput(e)),
  }));
  const failed = results.filter((r) => r.actual !== r.expected);
  if (failed.length)
    throw new WasmError(
      "EXAMPLE_MISMATCH",
      `failed independent examples: ${failed.map((e) => e.id).join(", ")}`,
    );
  return results;
}
function parseResolver(input: unknown): ResolutionLock["resolver"] {
  const r = record(input, ["provider", "model", "responseId", "usage"]);
  let usage: ResolverReply["usage"] = null;
  if (r.usage !== null) {
    const u = record(r.usage, ["inputTokens", "outputTokens", "totalTokens"]);
    for (const key of ["inputTokens", "outputTokens", "totalTokens"])
      if (!Number.isSafeInteger(u[key]) || Number(u[key]) < 0)
        fail("invalid usage");
    usage = {
      inputTokens: Number(u.inputTokens),
      outputTokens: Number(u.outputTokens),
      totalTokens: Number(u.totalTokens),
    };
    if (usage.totalTokens !== usage.inputTokens + usage.outputTokens)
      fail("invalid total token count");
  }
  return {
    provider: stringValue(r.provider, "provider"),
    model: stringValue(r.model, "model"),
    responseId: stringValue(r.responseId, "responseId"),
    usage,
  };
}
function parseStoredLock(input: unknown): ResolutionLock {
  const r = record(input, [
    "version",
    "protocol",
    "sourceHash",
    "irHash",
    "body",
    "resolver",
    "diagnostics",
    "checksum",
  ]);
  if (r.version !== 1 || r.protocol !== RESOLUTION_PROTOCOL)
    fail("unsupported resolution protocol");
  if (typeof r.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(r.sourceHash))
    fail("invalid source hash");
  const body = parsePredicateExpression(r.body);
  if (r.irHash !== contentHash(body)) fail("IR hash mismatch");
  const result = parseElaborationResult({
    outcome: "resolved",
    body,
    diagnostics: r.diagnostics,
  });
  const unsigned = {
    version: 1 as const,
    protocol: RESOLUTION_PROTOCOL as typeof RESOLUTION_PROTOCOL,
    sourceHash: r.sourceHash,
    irHash: contentHash(body),
    body,
    resolver: parseResolver(r.resolver),
    diagnostics: result.diagnostics,
  };
  if (r.checksum !== contentHash(unsigned)) fail("lock checksum mismatch");
  return { ...unsigned, checksum: contentHash(unsigned) };
}
export function parseResolutionLock(
  input: unknown,
  source: PromptSource,
): ResolutionLock {
  const lock = parseStoredLock(input);
  if (lock.sourceHash !== contentHash(source))
    throw new WasmError(
      "STALE_LOCK",
      "source changed; explicitly resolve again",
    );
  verifyExamples(source, lock.body);
  return lock;
}
export async function readPromptResolution(path: string) {
  const { source, revision } = await readPromptSource(path);
  const lock = parseResolutionLock(await readJson(`${path}.lock.json`), source);
  return { source, revision, lock };
}
async function optionalLock(path: string): Promise<unknown> {
  try {
    return await readJson(`${path}.lock.json`);
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT")
      return undefined;
    throw e;
  }
}
function optionalHash(value: unknown): string {
  return contentHash({ exists: value !== undefined, value: value ?? null });
}
export async function resolvePromptSource(
  path: string,
  resolver: PromptResolver,
) {
  const { source, revision } = await readPromptSource(path);
  const previous = await optionalLock(path);
  if (previous !== undefined) {
    // Corruption is not a cache miss. Only a valid lock for an old source is replaceable.
    const prior = parseStoredLock(previous);
    if (prior.sourceHash === revision)
      return {
        lock: parseResolutionLock(previous, source),
        apiCalls: 0,
        reused: true,
      };
  }
  const reply = await resolver(resolutionInput(source));
  const result = parseElaborationResult(reply.result);
  if (result.outcome === "unresolved")
    throw new WasmError(
      "UNRESOLVED",
      result.diagnostics.join("; ") || "meaning could not be resolved",
    );
  verifyExamples(source, result.body);
  const unsigned = {
    version: 1 as const,
    protocol: RESOLUTION_PROTOCOL as typeof RESOLUTION_PROTOCOL,
    sourceHash: revision,
    irHash: contentHash(result.body),
    body: result.body,
    resolver: parseResolver({
      provider: reply.provider,
      model: reply.model,
      responseId: reply.responseId,
      usage: reply.usage,
    }),
    diagnostics: result.diagnostics,
  };
  const lock = parseResolutionLock(
    { ...unsigned, checksum: contentHash(unsigned) },
    source,
  );
  await sourceTransaction(path, async (file) => {
    if (
      (await readPromptSource(file)).revision !== revision ||
      optionalHash(await optionalLock(file)) !== optionalHash(previous)
    )
      throw new WasmError(
        "SOURCE_CONFLICT",
        "source or lock changed during resolution",
      );
    await atomicWriteJson(`${file}.lock.json`, lock);
  });
  return {
    lock,
    apiCalls: reply.provider === "fixture" ? 0 : 1,
    reused: false,
  };
}
