import { describe, expect, test } from "bun:test";

import {
  buildAuthenticationHeaders,
  buildOpenAIRequest,
  DEFAULT_OPENAI_MODEL,
  parseElaborationResult,
  parseOpenAIResponse,
  predicateElaborationJsonSchema,
  resolveOpenAIConnection,
} from "./openai";
import { SEMANTIC_LIMITS } from "./semantic-limits";

describe("OpenAI adapter", () => {
  test("uses GPT-5.4 mini as the default model", () => {
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-5.4-mini");
  });

  test("normalizes an Azure endpoint and uses the api-key header", () => {
    const connection = resolveOpenAIConnection({
      apiKey: "test-key",
      baseUrl: "https://example.openai.azure.com",
    });

    expect(connection).toEqual({
      provider: "azure-openai",
      apiKey: "test-key",
      baseUrl: "https://example.openai.azure.com/openai/v1",
      authMode: "api-key",
    });
    expect(buildAuthenticationHeaders(connection)).toEqual({
      "api-key": "test-key",
      "Content-Type": "application/json",
    });
  });

  test("keeps the OpenAI bearer authentication path", () => {
    const connection = resolveOpenAIConnection({
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
    });

    expect(connection.provider).toBe("openai");
    expect(buildAuthenticationHeaders(connection)).toEqual({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
  });

  test("builds a non-persisted structured output request", () => {
    const request = buildOpenAIRequest({
      model: "gpt-test",
      specification: "enabledであること",
      typeScriptSource: "type Account = { enabled: boolean }",
      target: {
        functionName: "isEnabled",
        parameterName: "account",
        typeName: "Account",
      },
    }) as {
      store: boolean;
      text: { format: { type: string; strict: boolean } };
    };

    expect(request.store).toBe(false);
    expect(request.text.format.type).toBe("json_schema");
    expect(request.text.format.strict).toBe(true);
    expect(
      predicateElaborationJsonSchema.$defs.expression.anyOf[0].properties
        .conditions.maxItems,
    ).toBe(SEMANTIC_LIMITS.predicateConditions);
    expect(
      predicateElaborationJsonSchema.$defs.expression.anyOf[2].properties
        .property.maxItems,
    ).toBe(SEMANTIC_LIMITS.propertyPathSegments);
    expect(
      predicateElaborationJsonSchema.$defs.expression.anyOf[2].properties
        .property.items.maxLength,
    ).toBe(SEMANTIC_LIMITS.propertySegmentCharacters);
  });

  test("uses an explicit per-call output token limit when provided", () => {
    const request = buildOpenAIRequest({
      model: "gpt-test",
      specification: "enabledであること",
      typeScriptSource: "type Account = { enabled: boolean }",
      target: {
        functionName: "isEnabled",
        parameterName: "account",
        typeName: "Account",
      },
      maxOutputTokens: 240,
    }) as { max_output_tokens: number };

    expect(request.max_output_tokens).toBe(240);
  });

  test("delimits Project Context as source data without hidden artifacts", () => {
    const request = buildOpenAIRequest({
      model: "gpt-test",
      specification: "readyであること",
      typeScriptSource: 'type Item = { state: "ready" | "blocked" }',
      target: {
        functionName: "isReady",
        parameterName: "item",
        typeName: "Item",
      },
      projectContext: {
        version: 1,
        target: {
          source: "item.semantic.ts",
          symbol: "isReady",
          typeName: "Item",
          typeDeclaration: 'type Item = { state: "ready" | "blocked" }',
        },
        relatedTypes: [],
        verifiedBindings: [],
        compilerContext: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
        },
      },
    }) as { input: string; instructions: string };

    expect(request.input).toContain("<project_context>");
    expect(request.input).toContain('"version":1');
    expect(request.input).not.toContain("hiddenCases");
    expect(request.instructions).toContain("advisory evidence");
  });

  test("parses an OpenAI Responses API output", () => {
    const response = parseOpenAIResponse({
      id: "resp_test",
      model: "gpt-test",
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                outcome: "resolved",
                body: {
                  kind: "equals",
                  property: ["enabled"],
                  value: true,
                },
                diagnostics: [],
              }),
            },
          ],
        },
      ],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 15,
      },
    });

    const elaboration = parseElaborationResult(JSON.parse(response.outputText));
    expect(elaboration.outcome).toBe("resolved");
  });

  test("rejects token usage that could bypass budget accounting", () => {
    for (const usage of [
      {
        input_tokens: -1,
        output_tokens: 5,
        total_tokens: 4,
      },
      {
        input_tokens: 10.5,
        output_tokens: 5,
        total_tokens: 15.5,
      },
      {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: -1 },
        output_tokens: 5,
        total_tokens: 15,
      },
    ]) {
      expect(() => parseOpenAIResponse(responseWithUsage(usage))).toThrow(
        "non-negative safe integer",
      );
    }
  });

  test("stops on an explicit refusal", () => {
    expect(() =>
      parseOpenAIResponse({
        id: "resp_test",
        model: "gpt-test",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "cannot comply" }],
          },
        ],
      }),
    ).toThrow("refused elaboration");
  });

  test("accepts an explicit unresolved result", () => {
    expect(
      parseElaborationResult({
        outcome: "unresolved",
        body: null,
        diagnostics: ["The specification requires a function call."],
      }),
    ).toEqual({
      outcome: "unresolved",
      body: null,
      diagnostics: ["The specification requires a function call."],
    });
  });

  test("rejects unknown elaboration fields and oversized diagnostics", () => {
    expect(() =>
      parseElaborationResult({
        outcome: "unresolved",
        body: null,
        diagnostics: [],
        extra: true,
      }),
    ).toThrow("unknown field");
    expect(() =>
      parseElaborationResult({
        outcome: "unresolved",
        body: null,
        diagnostics: Array.from(
          { length: SEMANTIC_LIMITS.diagnostics + 1 },
          () => "diagnostic",
        ),
      }),
    ).toThrow("at most");
    expect(() =>
      parseElaborationResult({
        outcome: "unresolved",
        body: null,
        diagnostics: ["x".repeat(SEMANTIC_LIMITS.diagnosticCharacters + 1)],
      }),
    ).toThrow("at most");
  });

  test("rejects an oversized structured output payload", () => {
    expect(() =>
      parseOpenAIResponse({
        id: "resp_test",
        model: "gpt-test",
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(
                  "x".repeat(SEMANTIC_LIMITS.externalJsonBytes),
                ),
              },
            ],
          },
        ],
      }),
    ).toThrow("exceeds");
  });
});

function responseWithUsage(usage: Record<string, unknown>): object {
  return {
    id: "resp_usage",
    model: "gpt-test",
    status: "completed",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              outcome: "unresolved",
              body: null,
              diagnostics: [],
            }),
          },
        ],
      },
    ],
    usage,
  };
}
