import { lstat, readFile } from "node:fs/promises";
import type {
  DevelopmentAgent,
  DevelopmentRequest,
} from "./capability-test-agent";
import { parseAgentReply } from "./capability-test-agent";
import {
  decodeUtf8,
  LLANG_SOURCE_BYTES,
  parseStrictJsonObject,
} from "./llang-jsonc";
import { record, WasmError } from "./wasm-contract";

export type LlangDevelopmentConfig = {
  version: 2;
  mode: "fixture" | "live" | "replay";
  model: string;
  maxCalls: 1 | 2;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxWallMs: number;
};
export async function readDevelopmentJson(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > LLANG_SOURCE_BYTES)
    throw new WasmError(
      "INVALID_CAPABILITY",
      "development snapshot must be a bounded regular file",
    );
  const bytes = await readFile(path);
  if (bytes.byteLength > LLANG_SOURCE_BYTES)
    throw new WasmError(
      "INVALID_CAPABILITY",
      "development snapshot exceeds size limit",
    );
  return parseStrictJsonObject(decodeUtf8(bytes, path), path);
}

const programSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["generated", "unresolved", "error"] },
    program: {
      anyOf: [{ $ref: "#/$defs/program" }, { type: "null" }],
    },
    diagnostics: {
      type: "array",
      maxItems: 32,
      items: { type: "string", maxLength: 2000 },
    },
  },
  required: ["outcome", "program", "diagnostics"],
  $defs: {
    program: {
      type: "object",
      additionalProperties: false,
      properties: {
        language: { type: "string", enum: ["l-lang"] },
        version: { type: "integer", enum: [1] },
        id: { type: "string" },
        profile: { type: "string", enum: ["predicate-i32-v1"] },
        description: { type: "string" },
        contract: { $ref: "#/$defs/contract" },
        body: { $ref: "#/$defs/expression" },
      },
      required: [
        "language",
        "version",
        "id",
        "profile",
        "description",
        "contract",
        "body",
      ],
    },
    contract: {
      type: "object",
      additionalProperties: false,
      properties: {
        version: { type: "integer", enum: [1] },
        fields: {
          type: "array",
          items: { $ref: "#/$defs/field" },
        },
      },
      required: ["version", "fields"],
    },
    field: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: ["boolean", "enum", "string"] },
        values: { type: "array", items: { type: "string" } },
        nullable: { type: "boolean" },
        undefinable: { type: "boolean" },
        optional: { type: "boolean" },
      },
      required: [
        "name",
        "kind",
        "values",
        "nullable",
        "undefinable",
        "optional",
      ],
    },
    expression: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["all", "any"] },
            conditions: {
              type: "array",
              items: { $ref: "#/$defs/expression" },
            },
          },
          required: ["kind", "conditions"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["not"] },
            condition: { $ref: "#/$defs/expression" },
          },
          required: ["kind", "condition"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["equals"] },
            property: { type: "array", items: { type: "string" } },
            value: {
              anyOf: [
                { type: "string" },
                { type: "boolean" },
                { type: "null" },
              ],
            },
          },
          required: ["kind", "property", "value"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["present"] },
            property: { type: "array", items: { type: "string" } },
          },
          required: ["kind", "property"],
        },
      ],
    },
  },
};

export function parseConfig(input: unknown): LlangDevelopmentConfig {
  const value = record(input, [
    "version",
    "mode",
    "model",
    "maxCalls",
    "maxOutputTokens",
    "maxTotalTokens",
    "maxWallMs",
  ]);
  if (
    value.version !== 2 ||
    !["fixture", "live", "replay"].includes(String(value.mode)) ||
    !Number.isSafeInteger(value.maxCalls) ||
    ![1, 2].includes(value.maxCalls as number) ||
    typeof value.model !== "string" ||
    !value.model ||
    value.model.length > 256 ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    Number(value.maxOutputTokens) < 256 ||
    Number(value.maxOutputTokens) > 16384 ||
    !Number.isSafeInteger(value.maxTotalTokens) ||
    Number(value.maxTotalTokens) < 1 ||
    Number(value.maxTotalTokens) > 10_000_000 ||
    !Number.isSafeInteger(value.maxWallMs) ||
    Number(value.maxWallMs) < 1 ||
    Number(value.maxWallMs) > 3_600_000
  )
    throw new WasmError(
      "INVALID_CAPABILITY",
      "invalid L-Lang development config",
    );
  return value as LlangDevelopmentConfig;
}

export function requestFor(
  request: unknown,
  previous?: { program: unknown; report: unknown },
): DevelopmentRequest {
  return {
    stage: previous ? "repair" : "implementation",
    instruction: previous
      ? "Repair only the L-Lang Program implementation using the fixed test failures. Do not change the request, contract, or tests. Return outcome, the complete program object, and concise diagnostics."
      : "Create an L-Lang Program from the fixed request and contract. The program must use language l-lang, version 1, profile predicate-i32-v1, and only all/any/not/equals/present predicate IR. Do not change the request or contract. Return outcome, the complete program object, and concise diagnostics.",
    input: previous ? { request, previous } : { request },
    schema: programSchema,
  };
}

export function parseProgramResult(input: unknown) {
  const value = record(input, ["outcome", "program", "diagnostics"]);
  if (
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > 32 ||
    value.diagnostics.some(
      (item) => typeof item !== "string" || item.length > 2000,
    )
  )
    throw new WasmError("INVALID_CAPABILITY", "invalid agent diagnostics");
  if (
    value.outcome === "generated" &&
    value.program &&
    typeof value.program === "object"
  )
    return {
      outcome: "generated" as const,
      program: value.program,
      diagnostics: value.diagnostics as string[],
    };
  if (
    (value.outcome === "unresolved" || value.outcome === "error") &&
    value.program === null &&
    value.diagnostics.length
  )
    return {
      outcome: value.outcome,
      program: null,
      diagnostics: value.diagnostics as string[],
    };
  throw new WasmError("INVALID_CAPABILITY", "invalid agent program response");
}

export function fixtureLlangAgent(input: unknown): DevelopmentAgent {
  const value = record(input, ["version", "responses"]);
  if (
    value.version !== 2 ||
    !Array.isArray(value.responses) ||
    value.responses.length > 2
  )
    throw new WasmError("INVALID_CAPABILITY", "invalid L-Lang fixture");
  const responses = value.responses as unknown[];
  let index = 0;
  return async (request) => {
    const item = record(responses[index++], ["stage", "reply"]);
    if (item.stage !== request.stage)
      throw new WasmError("INVALID_CAPABILITY", "fixture stage mismatch");
    return parseAgentReply(item.reply);
  };
}
