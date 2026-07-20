import { describe, expect, test } from "bun:test";

import {
  buildOpenAIRequest,
  buildAuthenticationHeaders,
  DEFAULT_OPENAI_MODEL,
  parseElaborationResult,
  parseOpenAIResponse,
  resolveOpenAIConnection,
} from "./openai";

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
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });

    const elaboration = parseElaborationResult(JSON.parse(response.outputText));
    expect(elaboration.outcome).toBe("resolved");
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
});
