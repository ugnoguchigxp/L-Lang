import {
  type CapabilitySuite,
  caseInput,
  invalid,
  parseCapabilitySuite,
} from "./capability-tests";
import { type ResolverReply, resolutionInput } from "./prompt-resolution";
import {
  contentHash,
  exampleInput,
  list,
  type PromptSource,
  stringValue,
} from "./prompt-source";
import { record, WASM_LIMITS } from "./wasm-contract";

export type DevelopmentStage = "tests" | "implementation" | "repair";
export type DevelopmentRequest = {
  stage: DevelopmentStage;
  instruction: string;
  input: unknown;
  schema: object;
};
export type DevelopmentAgent = (
  request: DevelopmentRequest,
  signal?: AbortSignal,
) => Promise<ResolverReply>;
export const testGenerationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["generated", "unresolved", "error"] },
    suiteJson: { type: ["string", "null"] },
    diagnostics: { type: "array", items: { type: "string" } },
  },
  required: ["outcome", "suiteJson", "diagnostics"],
};
export function testGenerationRequest(
  source: PromptSource,
): DevelopmentRequest {
  return {
    stage: "tests",
    instruction:
      "Produce independent unit tests from the requirements and contract, not implementation outputs. Return generated with suiteJson containing a JSON object {version:1,sourceRevision,cases:[{id,requirementIds,input,undefinedFields,expected}]}. expected is {kind:'value',value:boolean} or {kind:'error',code:'INVALID_INPUT'}. Include positive and negative cases and cover each must/must-not requirement. Preserve the supplied revision. Use undefinedFields to represent explicit undefined, not omission. If requirements cannot be tested unambiguously, return unresolved and suiteJson:null. No chain of thought.",
    input: { sourceRevision: contentHash(source), ...resolutionInput(source) },
    schema: testGenerationSchema,
  };
}
function inputKey(input: Record<string, unknown>) {
  const keys = Object.keys(input).sort();
  return contentHash(
    keys.map((key) => [
      key,
      input[key] === undefined
        ? { state: "undefined" }
        : { state: "value", value: input[key] },
    ]),
  );
}
export function parseGeneratedTests(
  input: unknown,
  source: PromptSource,
):
  | { outcome: "generated"; suite: CapabilitySuite; diagnostics: string[] }
  | { outcome: "unresolved" | "error"; suite: null; diagnostics: string[] } {
  const r = record(input, ["outcome", "suiteJson", "diagnostics"]);
  const diagnostics = list(r.diagnostics, "diagnostics").map((v) =>
    stringValue(v, "diagnostic"),
  );
  if (r.outcome === "unresolved" || r.outcome === "error") {
    if (r.suiteJson !== null || !diagnostics.length)
      invalid("unresolved/error needs diagnostics and null suite");
    return { outcome: r.outcome, suite: null, diagnostics };
  }
  if (
    r.outcome !== "generated" ||
    typeof r.suiteJson !== "string" ||
    Buffer.byteLength(r.suiteJson) > WASM_LIMITS.bytes
  )
    invalid("invalid generated suite envelope");
  const suite = parseCapabilitySuite(JSON.parse(r.suiteJson), source);
  const expectations = new Map(
    source.examples.map((e) => [
      inputKey(exampleInput(e)),
      JSON.stringify({ kind: "value", value: e.expected }),
    ]),
  );
  for (const c of suite.cases) {
    const key = inputKey(caseInput(c));
    const expected = JSON.stringify(c.expected);
    if (expectations.has(key) && expectations.get(key) !== expected)
      invalid("test expectations contradict Source examples or another test");
    expectations.set(key, expected);
  }
  return { outcome: "generated", suite, diagnostics };
}
export async function implementationRequest(
  source: PromptSource,
  previous?: { body: unknown; failures: unknown; packageHash: string },
): Promise<DevelopmentRequest> {
  const { predicateElaborationJsonSchema } = await import("./openai");
  return {
    stage: previous ? "repair" : "implementation",
    instruction:
      "Resolve the fixed requirements into predicate IR: all/any/not/equals/present, single-field paths, boolean or declared enum equality and string presence only. No IO, memory, clock or coercion. Return resolved or unresolved with concise diagnostics. Do not modify requirements, contract, examples or test expectations. For repair, correct the implementation using the reported failures; return only a new IR result, never patches to tests or Source. No chain of thought.",
    input: previous
      ? { source: resolutionInput(source), previous }
      : resolutionInput(source),
    schema: predicateElaborationJsonSchema,
  };
}
export function parseAgentReply(input: unknown): ResolverReply {
  const r = record(input, [
    "result",
    "provider",
    "model",
    "responseId",
    "usage",
  ]);
  if (!Object.hasOwn(r, "result")) invalid("missing agent result");
  let usage: ResolverReply["usage"] = null;
  if (r.usage !== null) {
    const u = record(r.usage, ["inputTokens", "outputTokens", "totalTokens"]);
    if (
      ![u.inputTokens, u.outputTokens, u.totalTokens].every(
        (v) => Number.isSafeInteger(v) && Number(v) >= 0,
      ) ||
      Number(u.totalTokens) !== Number(u.inputTokens) + Number(u.outputTokens)
    )
      invalid("invalid agent usage");
    usage = {
      inputTokens: Number(u.inputTokens),
      outputTokens: Number(u.outputTokens),
      totalTokens: Number(u.totalTokens),
    };
  }
  return {
    result: r.result,
    provider: stringValue(r.provider, "provider"),
    model: stringValue(r.model, "model"),
    responseId: stringValue(r.responseId, "responseId"),
    usage,
  };
}
