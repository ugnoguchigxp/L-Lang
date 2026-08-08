import { describe, expect, test } from "bun:test";

import { compileSemanticContract } from "./semantic-contract";
import { SEMANTIC_LIMITS } from "./semantic-limits";
import { scanSemanticSource } from "./semantic-source";
import {
  buildSemanticTestSynthesisRequest,
  parseSemanticTestSynthesisResult,
} from "./semantic-test-synthesizer";

const example = new URL(
  "../examples/active-customer/semantic.ts",
  import.meta.url,
).pathname;

describe("separated Semantic Test synthesis", () => {
  test("builds a request from contract and type without implementation artifacts", async () => {
    const source = await scanSemanticSource(example);
    const compiled = compileSemanticContract(source);
    const request = buildSemanticTestSynthesisRequest({
      model: "fixture-model",
      contract: compiled.contract,
      contractHash: compiled.contractHash,
      typeScriptSource: source.concept.typeDeclaration,
    }) as { input: string };

    expect(request.input).toContain(compiled.contractHash);
    expect(request.input).toContain("requirements[0]");
    expect(request.input).toContain("export type Customer");
    expect(request.input).not.toContain("resolvedIr");
    expect(request.input).not.toContain("generatedCode");
    expect(request.input).not.toContain("hidden");
  });

  test("strictly separates resolved and unresolved results", () => {
    expect(
      parseSemanticTestSynthesisResult({
        outcome: "unresolved",
        plan: null,
        diagnostics: ["contract is ambiguous"],
      }),
    ).toEqual({
      outcome: "unresolved",
      plan: null,
      diagnostics: ["contract is ambiguous"],
    });
    expect(() =>
      parseSemanticTestSynthesisResult({
        outcome: "resolved",
        plan: null,
        diagnostics: [],
      }),
    ).toThrow("requires a plan");
    expect(() =>
      parseSemanticTestSynthesisResult({
        outcome: "unresolved",
        plan: null,
        diagnostics: [],
      }),
    ).toThrow("requires diagnostics");
  });

  test("enforces the shared diagnostic resource budget", () => {
    expect(() =>
      parseSemanticTestSynthesisResult({
        outcome: "unresolved",
        plan: null,
        diagnostics: Array.from(
          { length: SEMANTIC_LIMITS.diagnostics + 1 },
          () => "ambiguous",
        ),
      }),
    ).toThrow(`at most ${SEMANTIC_LIMITS.diagnostics} items`);
    expect(() =>
      parseSemanticTestSynthesisResult({
        outcome: "unresolved",
        plan: null,
        diagnostics: [
          "x".repeat(SEMANTIC_LIMITS.diagnosticCharacters + 1),
        ],
      }),
    ).toThrow(
      `at most ${SEMANTIC_LIMITS.diagnosticCharacters} characters`,
    );
  });
});
