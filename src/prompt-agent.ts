import {
  callResponsesApi,
  predicateElaborationJsonSchema,
  type resolveOpenAIConnection,
} from "./openai";
import {
  type PromptResolver,
  RESOLUTION_PROTOCOL,
  type ResolverReply,
} from "./prompt-resolution";
import {
  fail,
  type PromptSource,
  parseMeaning,
  parsePatches,
  stringValue,
} from "./prompt-source";

const textSchema = { type: "string", minLength: 1, maxLength: 4096 };
const idSchema = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" };
const requirementSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: idSchema,
    level: { type: "string", enum: ["must", "must-not", "should"] },
    text: textSchema,
  },
  required: ["id", "level", "text"],
};
export const meaningSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: textSchema,
    requirements: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: requirementSchema,
    },
    unresolvedWhen: { type: "array", maxItems: 128, items: textSchema },
  },
  required: ["intent", "requirements", "unresolvedWhen"],
};
export const patchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    changes: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: idSchema,
          replacement: { anyOf: [requirementSchema, { type: "null" }] },
        },
        required: ["id", "replacement"],
      },
    },
  },
  required: ["changes"],
};
export type StructuredAgent = (
  instruction: string,
  input: unknown,
  schema: object,
) => Promise<ResolverReply>;
export function makeOpenAIAgent(
  model: string,
  maxOutputTokens: number,
  connection: ReturnType<typeof resolveOpenAIConnection>,
  send = callResponsesApi,
): StructuredAgent {
  stringValue(model, "model");
  if (
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 256 ||
    maxOutputTokens > 16384
  )
    fail("max-output-tokens must be 256..16384");
  return async (instruction, input, schema) => {
    const content = JSON.stringify(input);
    if (Buffer.byteLength(content) > 128 * 1024)
      fail("model input exceeds 128 KiB");
    const response = await send(
      {
        model,
        store: false,
        max_output_tokens: maxOutputTokens,
        input: [
          { role: "system", content: instruction },
          { role: "user", content },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "llang_prompt",
            strict: true,
            schema,
          },
        },
      },
      connection,
    );
    if (!response.usage) fail("live response is missing token usage");
    return {
      result: JSON.parse(response.outputText),
      provider: connection.provider,
      model: response.model,
      responseId: response.responseId,
      usage: response.usage,
    };
  };
}
export async function proposeMeaning(
  agent: StructuredAgent,
  request: string,
  contract: PromptSource["contract"],
) {
  const reply = await agent(
    "Author a predicate Prompt Source from the user's request. Return precise requirements with stable IDs and unresolvedWhen conditions. Do not invent missing business rules. must-not denotes prohibited behavior; should is still a stated semantic requirement, not permission to ignore it. Runtime is pure, total, deterministic, without memory/imports. No code, tests, or chain of thought.",
    { request: stringValue(request, "request"), contract },
    meaningSchema,
  );
  return {
    meaning: parseMeaning(reply.result),
    audit: { ...reply, result: undefined },
  };
}
export async function proposePatch(
  agent: StructuredAgent,
  source: PromptSource,
  request: string,
  allowedIds: string[],
) {
  const reply = await agent(
    "Return only requirement changes for allowedIds. Use replacement:null for deletion. Preserve all other requirements, contract and tests. Do not rename IDs or invent requirements outside the request. No chain of thought.",
    {
      request: stringValue(request, "request"),
      allowedIds,
      intent: source.intent,
      requirements: source.requirements,
      contract: source.contract,
    },
    patchSchema,
  );
  const changes = parsePatches(reply.result);
  if (changes.some((c) => !allowedIds.includes(c.id)))
    fail("model patch exceeds authorized IDs");
  return { changes };
}
export function makePromptResolver(agent: StructuredAgent): PromptResolver {
  return async (source) =>
    agent(
      `Resolve the following Prompt Source to Predicate IR under ${RESOLUTION_PROTOCOL}. Use only all/any/not/equals/present and single-field paths. Booleans and declared enum literals support equality; general strings support presence only. No memory, imports, coercion, IO, or clock. All stated requirements must hold. Return unresolved with diagnostics for ambiguity, contradiction, unsupported behavior or unresolvedWhen conditions; do not guess. Output concise diagnostics, no chain of thought.`,
      source,
      predicateElaborationJsonSchema,
    );
}
