import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileSemanticContract } from "./semantic-contract";
import { sha256, stableJson } from "./semantic-fingerprint";
import { scanSemanticSource, type SemanticSource } from "./semantic-source";
import {
  validateSemanticTestPlan,
  type ValidatedSemanticTestPlan,
} from "./semantic-test-ir";
import {
  bestOfNRequest,
  collectBestOfNCandidates,
  evaluateBestOfN,
  parseBestOfNConfig,
  parseBestOfNReport,
  verifyBestOfNSelection,
  type BestOfNConfig,
  type BestOfNTrial,
} from "./semantic-tdd-best-of-n";
import { parseSemanticTddSelectionReport } from "./semantic-tdd-selection-report";
import type { PredicateExpression } from "./ir";

const config: BestOfNConfig = {
  version: 1,
  candidates: 3,
  maxOutputTokensPerCall: 200,
  maxTotalTokens: 10000,
  timeoutMs: 1000,
  maxCostUsd: 1,
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 2,
};
const good: PredicateExpression = {
  kind: "all",
  conditions: [
    { kind: "equals", property: ["status"], value: "active" },
    { kind: "equals", property: ["deletedAt"], value: null },
    { kind: "present", property: ["email"] },
  ],
};
let source: SemanticSource;
let validated: ValidatedSemanticTestPlan;
beforeAll(async () => {
  source = await scanSemanticSource(
    resolve(import.meta.dir, "../examples/active-customer/semantic.ts"),
  );
  const contract = compileSemanticContract(source);
  const fixture = JSON.parse(
    await readFile(
      resolve(
        import.meta.dir,
        "../examples/active-customer/semantic-test-response.fixture.json",
      ),
      "utf8",
    ),
  );
  fixture.plan.contractHash = contract.contractHash;
  validated = validateSemanticTestPlan(
    fixture.plan,
    contract.contract,
    contract.contractHash,
  );
});
const trial = (body: PredicateExpression, index: number): BestOfNTrial => ({
  id: `candidate-${index + 1}`,
  output: { outcome: "resolved", body, diagnostics: [] },
  rawOutput: { fixture: index },
  response: null,
  failure: null,
});
const request = () =>
  bestOfNRequest(
    {
      specification: source.concept.specification,
      typeScriptSource: source.concept.typeDeclaration,
      functionName: source.predicate.name,
      parameterName: source.predicate.parameterName,
      typeName: source.concept.typeName,
    },
    validated,
  );
const evaluate = (trials: BestOfNTrial[]) =>
  evaluateBestOfN({
    source,
    validated,
    config: { ...config, candidates: trials.length },
    request: request(),
    fixture: true,
    trials,
    resourceFailure: null,
  });

describe("Best-of-N selection", () => {
  test("selects independently of ordering and records duplicate IRs and rejected candidates", () => {
    const redundant: PredicateExpression = {
      kind: "all",
      conditions: [good, good],
    };
    const trials = [
      trial(redundant, 0),
      trial(good, 1),
      trial({ kind: "equals", property: ["status"], value: "active" }, 2),
    ];
    const first = evaluate(trials);
    const second = evaluate(
      [...trials.slice(1), ...trials.slice(0, 1)].map((t, i) => ({
        ...t,
        id: `candidate-${i + 1}`,
      })),
    );
    expect(first.selected?.elaboration).toEqual(second.selected?.elaboration);
    expect(first.report.selectedCandidate).toBe("candidate-2");
    expect(first.report.candidates[2]?.hardPassed).toBe(false);
    verifyBestOfNSelection(first.report, source, validated, good);
    expect(parseSemanticTddSelectionReport(first.report)).toEqual(first.report);
    const duplicates = evaluate([trial(good, 0), trial(good, 1)]);
    expect(duplicates.report.selectedCandidate).toBe("candidate-1");
  });
  test("rejects all ineligible candidates and unknown config fields", () => {
    const result = evaluate([
      trial({ kind: "equals", property: ["missing"], value: true }, 0),
    ]);
    expect(result.selected).toBeNull();
    expect(result.report.outcome).toBe("unresolved");
    expect(() => parseBestOfNConfig({ ...config, candidates: 6 })).toThrow();
    expect(() => parseBestOfNConfig({ ...config, judge: true })).toThrow(
      "unknown field",
    );
    const unresolved = evaluate([
      {
        id: "candidate-1",
        output: {
          outcome: "unresolved",
          body: null,
          diagnostics: ["missing role"],
        },
        rawOutput: null,
        response: null,
        failure: null,
      },
    ]);
    expect(parseBestOfNReport(unresolved.report).candidates).toEqual([]);
  });
  test("detects metric, input, candidate, selected ID, and resource counter tampering", () => {
    const { report } = evaluate([trial(good, 0), trial(good, 1)]);
    expect(() =>
      verifyBestOfNSelection(
        {
          ...report,
          candidates: report.candidates.map((c) => ({
            ...c,
            mutationScore: 0.5,
          })),
        },
        source,
        validated,
        good,
      ),
    ).toThrow("replay mismatch");
    expect(() =>
      verifyBestOfNSelection(
        { ...report, selectedCandidate: "candidate-2" },
        source,
        validated,
        good,
      ),
    ).toThrow("replay mismatch");
    const tamperedRequest = { ...report.request, specification: "changed" };
    expect(() =>
      verifyBestOfNSelection(
        {
          ...report,
          request: tamperedRequest,
          requestHash: sha256(stableJson(tamperedRequest)),
        },
        source,
        validated,
        good,
      ),
    ).toThrow("snapshot mismatch");
    expect(() => parseBestOfNReport({ ...report, totalTokens: 1 })).toThrow(
      "accounting mismatch",
    );
    expect(() =>
      parseBestOfNReport({ ...report, requestHash: "0".repeat(64) }),
    ).toThrow("hash mismatch");
    const altered = structuredClone(report);
    const firstTrial = altered.trials[0];
    if (firstTrial === undefined) throw new Error("missing trial");
    firstTrial.output = {
      outcome: "resolved",
      body: { kind: "equals", property: ["status"], value: "active" },
      diagnostics: [],
    };
    expect(() =>
      verifyBestOfNSelection(altered, source, validated, good),
    ).toThrow("evidence hash mismatch");
  });
  test("uses identical cloned requests, continues fixture failures, and aborts timed-out calls", async () => {
    const requests: unknown[] = [];
    const collected = await collectBestOfNCandidates({
      config,
      request: request(),
      fixture: true,
      resolve: async (r) => {
        requests.push(structuredClone(r));
        r.specification = "resolver-local mutation";
        if (requests.length === 1) throw new Error("fixture failure");
        return {
          elaboration: { outcome: "resolved", body: good, diagnostics: [] },
          response: null,
          rawOutput: {},
        };
      },
    });
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[1]).toEqual(requests[2]);
    expect(collected.trials[0]?.failure).toBe("provider-error");
    expect(evaluate(collected.trials).report.outcome).toBe("selected");
    let aborted = false;
    const timed = await collectBestOfNCandidates({
      config: { ...config, candidates: 1, timeoutMs: 5 },
      request: request(),
      fixture: true,
      resolve: async (_, limits) =>
        new Promise((_, reject) => {
          limits.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    expect(aborted).toBe(true);
    expect(timed.trials[0]?.failure).toBe("provider-error");
  });
  test("refuses an oversized frozen request before invoking a resolver", async () => {
    let called = false;
    await expect(
      collectBestOfNCandidates({
        config,
        request: { ...request(), specification: "x".repeat(2 * 1024 * 1024) },
        fixture: true,
        resolve: async () => {
          called = true;
          throw new Error("must not send");
        },
      }),
    ).rejects.toThrow("request exceeds size limit");
    expect(called).toBe(false);
  });

  test("normalizes nullish callback output before persisting JSON evidence", async () => {
    const collected = await collectBestOfNCandidates({
      config: { ...config, candidates: 1 },
      request: request(),
      fixture: true,
      resolve: async () => ({
        elaboration: undefined,
        rawOutput: undefined,
        response: null,
      }),
    });
    const result = evaluateBestOfN({
      source,
      validated,
      config: { ...config, candidates: 1 },
      request: request(),
      fixture: true,
      ...collected,
    });
    expect(result.selected).toBeNull();
    expect(
      parseBestOfNReport(JSON.parse(JSON.stringify(result.report))),
    ).toEqual(result.report);
  });

  test("retains malformed candidate output and usage without retrying it", async () => {
    let calls = 0;
    const collected = await collectBestOfNCandidates({
      config,
      request: request(),
      fixture: false,
      resolve: async () => {
        calls++;
        return {
          elaboration:
            calls === 1
              ? { arbitrary: true }
              : { outcome: "resolved", body: good, diagnostics: [] },
          response: {
            responseId: `id-${calls}`,
            model: "model",
            outputText: "saved",
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          },
          rawOutput: { saved: calls },
        };
      },
    });
    expect(calls).toBe(3);
    expect(collected.trials[0]?.failure).toBe("invalid-output");
    expect(collected.trials[0]?.rawOutput).toEqual({ saved: 1 });
    const result = evaluateBestOfN({
      source,
      validated,
      config,
      request: request(),
      fixture: false,
      ...collected,
    });
    expect(result.report.selectedCandidate).toBe("candidate-2");
    expect(result.report.totalTokens).toBe(60);
    expect(result.report.candidateFailures[0]?.stage).toBe("invalid-output");
    expect(parseBestOfNReport(result.report)).toEqual(result.report);
    const tampered = structuredClone(result.report);
    const first = tampered.trials[0];
    if (first === undefined) throw new Error("missing trial");
    first.rawOutput = { changed: true };
    expect(() => parseBestOfNReport(tampered)).toThrow(
      "evidence hash mismatch",
    );
  });

  test("stops live collection on missing usage, output/total token or cost overrun", async () => {
    for (const [override, usage, expected] of [
      [{}, null, "missing-usage"],
      [
        {},
        { inputTokens: 1, outputTokens: 201, totalTokens: 202 },
        "output-token-budget",
      ],
      [
        { maxTotalTokens: 2 },
        { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        "total-token-budget",
      ],
      [
        { maxCostUsd: 0.000001 },
        { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        "cost-budget",
      ],
    ] as const) {
      const result = await collectBestOfNCandidates({
        config: { ...config, ...override },
        request: request(),
        fixture: false,
        resolve: async () => ({
          elaboration: { outcome: "resolved", body: good, diagnostics: [] },
          response: {
            responseId: "id",
            model: "model",
            outputText: "{}",
            usage,
          },
          rawOutput: {},
        }),
      });
      expect(result.resourceFailure).toBe(expected);
      expect(result.trials).toHaveLength(1);
      const evaluated = evaluateBestOfN({
        source,
        validated,
        config: { ...config, ...override },
        request: request(),
        fixture: false,
        ...result,
      });
      expect(evaluated.selected).toBeNull();
      expect(parseBestOfNReport(evaluated.report).apiCalls).toBe(1);
    }
  });
});
