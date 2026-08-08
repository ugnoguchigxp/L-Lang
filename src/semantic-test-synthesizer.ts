import type { OpenAIResult } from "./openai";
import type { SemanticContract } from "./semantic-contract";
import { SEMANTIC_LIMITS, validateDiagnostics } from "./semantic-limits";
import {
  parseSemanticTestPlan,
  type SemanticTestPlan,
} from "./semantic-test-ir";

export const SEMANTIC_TEST_PROMPT_VERSION = "semantic-test-synthesis-v1";

export type SemanticTestSynthesisResult =
  | {
      outcome: "resolved";
      plan: SemanticTestPlan;
      diagnostics: string[];
    }
  | {
      outcome: "unresolved";
      plan: null;
      diagnostics: string[];
    };

export type SemanticTestSynthesisResolution = {
  synthesis: SemanticTestSynthesisResult;
  response: OpenAIResult | null;
  rawOutput: unknown;
};

export type SemanticTestRequestInput = {
  model: string;
  contract: SemanticContract;
  contractHash: string;
  typeScriptSource: string;
};

export const semanticTestSynthesisJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["resolved", "unresolved"] },
    plan: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            version: { type: "number", enum: [1] },
            contractHash: { type: "string" },
            obligations: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: { $ref: "#/$defs/obligation" },
            },
          },
          required: ["version", "contractHash", "obligations"],
        },
        { type: "null" },
      ],
    },
    diagnostics: {
      type: "array",
      maxItems: SEMANTIC_LIMITS.diagnostics,
      items: {
        type: "string",
        maxLength: SEMANTIC_LIMITS.diagnosticCharacters,
      },
    },
  },
  required: ["outcome", "plan", "diagnostics"],
  $defs: {
    value: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string" },
        {
          type: "array",
          maxItems: 128,
          items: { $ref: "#/$defs/value" },
        },
        {
          type: "object",
          additionalProperties: { $ref: "#/$defs/value" },
        },
      ],
    },
    change: {
      type: "object",
      additionalProperties: false,
      properties: {
        property: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string" },
        },
        value: { $ref: "#/$defs/value" },
      },
      required: ["property", "value"],
    },
    obligation: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["example"] },
            sourceClauses: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
            strength: { type: "string", enum: ["hard", "exploratory"] },
            rationale: { type: "string" },
            input: { $ref: "#/$defs/value" },
            expected: { type: "boolean" },
          },
          required: [
            "id",
            "kind",
            "sourceClauses",
            "strength",
            "rationale",
            "input",
            "expected",
          ],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["counterfactual"] },
            sourceClauses: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
            strength: { type: "string", enum: ["hard", "exploratory"] },
            rationale: { type: "string" },
            base: { $ref: "#/$defs/value" },
            changes: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: { $ref: "#/$defs/change" },
            },
            expectedBefore: { type: "boolean" },
            expectedAfter: { type: "boolean" },
          },
          required: [
            "id",
            "kind",
            "sourceClauses",
            "strength",
            "rationale",
            "base",
            "changes",
            "expectedBefore",
            "expectedAfter",
          ],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["invariance"] },
            sourceClauses: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
            strength: { type: "string", enum: ["hard", "exploratory"] },
            rationale: { type: "string" },
            base: { $ref: "#/$defs/value" },
            changes: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: { $ref: "#/$defs/change" },
            },
          },
          required: [
            "id",
            "kind",
            "sourceClauses",
            "strength",
            "rationale",
            "base",
            "changes",
          ],
        },
      ],
    },
  },
} as const;

export function buildSemanticTestSynthesisRequest(
  input: SemanticTestRequestInput,
): object {
  const sourceData = {
    promptVersion: SEMANTIC_TEST_PROMPT_VERSION,
    contractHash: input.contractHash,
    contract: input.contract,
    typeScriptSource: input.typeScriptSource,
  };
  return {
    model: input.model,
    instructions: [
      "You are the Test Plan stage of a compiler.",
      "Derive a minimal Test Obligation IR from the supplied Semantic Contract and type.",
      "Every normative requirement and exclusion must be traced by at least one hard obligation.",
      "Include hard accepted and rejected expectations so constant true and false predicates both fail.",
      "Use counterfactual and invariance obligations only when their relation follows from the contract.",
      "Use only values and property paths representable by the supplied type.",
      "Do not invent domain rules or executable code.",
      "Return unresolved when the contract does not determine a complete non-vacuous plan.",
    ].join(" "),
    input: [
      "<semantic_test_source>",
      JSON.stringify(sourceData, null, 2),
      "</semantic_test_source>",
    ].join("\n"),
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "semantic_test_synthesis",
        strict: true,
        schema: semanticTestSynthesisJsonSchema,
      },
    },
    max_output_tokens: 6_000,
    store: false,
  };
}

export function parseSemanticTestSynthesisResult(
  input: unknown,
): SemanticTestSynthesisResult {
  const value = recordValue(input, "semanticTestSynthesis");
  exactKeys(value, ["outcome", "plan", "diagnostics"], "semanticTestSynthesis");
  const diagnostics = validateDiagnostics(
    value.diagnostics,
    "semanticTestSynthesis.diagnostics",
  );
  if (value.outcome === "unresolved") {
    if (value.plan !== null) {
      throw new Error("unresolved Semantic Test synthesis must have null plan");
    }
    if (diagnostics.length === 0) {
      throw new Error(
        "unresolved Semantic Test synthesis requires diagnostics",
      );
    }
    return { outcome: "unresolved", plan: null, diagnostics };
  }
  if (value.outcome === "resolved") {
    if (value.plan === null) {
      throw new Error("resolved Semantic Test synthesis requires a plan");
    }
    return {
      outcome: "resolved",
      plan: parseSemanticTestPlan(value.plan),
      diagnostics,
    };
  }
  throw new Error(
    "semanticTestSynthesis.outcome must be resolved or unresolved",
  );
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined)
    throw new Error(`${path} contains unknown field ${unknown}`);
  const missing = allowed.find((key) => !(key in value));
  if (missing !== undefined) throw new Error(`${path} is missing ${missing}`);
}

function recordValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}
