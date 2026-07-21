import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  createPredicateSemanticReview,
  createStaticJudgmentSemanticReview,
  parseReviewCandidate,
  readSemanticReviewCandidate,
} from "./semantic-review";
import {
  renderPredicateReviewDiff,
  renderStaticJudgmentReviewDiff,
} from "./semantic-review-renderer";
import { sha256 } from "./semantic-fingerprint";

const temporaryRoots: string[] = [];
const hash = (value: string) => sha256(value);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("semantic review candidate", () => {
  test("stores only the strict Predicate candidate contract", async () => {
    const workspaceRoot = await temporaryRoot();
    const created = await createPredicateSemanticReview({
      workspaceRoot,
      source: "predicate/semantic.ts",
      output: "predicate/is-ready.generated.ts",
      symbol: "isReady",
      conceptId: "customer.ready",
      provider: "fixture",
      model: "model",
      fingerprint: hash("fingerprint"),
      hashes: predicateHashes(),
      resolvedIr: { kind: "equals", property: ["state"], value: "ready" },
      baseline: undefined,
      response: null,
      generatedCode: "export const isReady = () => true;\n",
      typeSchema: {
        kind: "object",
        properties: [
          {
            name: "state",
            optional: false,
            type: {
              kind: "union",
              types: [
                { kind: "literal", value: "ready" },
                { kind: "literal", value: "waiting" },
              ],
            },
          },
        ],
      },
    });

    expect(created.candidate.id).toMatch(/^review-[0-9]{14}-[a-f0-9]{8}$/);
    expect((await readdir(created.candidateDirectory)).sort()).toEqual([
      "candidate.json",
      "candidate.ts",
      "diff.txt",
    ]);
    expect(await readFile(resolve(created.candidateDirectory, "diff.txt"), "utf8"))
      .toContain("NEW PREDICATE");
    const read = await readSemanticReviewCandidate(created.candidate.id, {
      workspaceRoot,
    });
    expect(read.candidate).toEqual(created.candidate);
  });

  test("stores a Static Judgment candidate with a separate payload", async () => {
    const workspaceRoot = await temporaryRoot();
    const created = await createStaticJudgmentSemanticReview({
      workspaceRoot,
      source: "judgment/semantic.ts",
      output: "judgment/mike-is-cat.generated.ts",
      symbol: "mikeIsCat",
      conceptId: "animal.cat",
      provider: "fixture",
      model: "model",
      fingerprint: hash("judgment-fingerprint"),
      hashes: staticHashes(),
      resolvedValue: true,
      baseline: undefined,
      response: null,
      generatedCode: "export const mikeIsCat = true as const;\n",
    });

    expect(created.candidate.kind).toBe("static-judgment");
    expect(created.candidate.validation.semanticTest).toBe("not-applicable");
    expect(await readFile(resolve(created.candidateDirectory, "diff.txt"), "utf8"))
      .toContain("NEW STATIC JUDGMENT");
  });

  test("rejects unknown fields, invalid timestamps, status metadata, and wrong-kind validation", () => {
    const cases: Array<(candidate: Record<string, any>) => void> = [
      (candidate) => { candidate.extra = true; },
      (candidate) => { candidate.createdAt = "yesterday"; },
      (candidate) => { candidate.reviewer = "alice"; },
      (candidate) => { candidate.validation.semanticTest = "not-applicable"; },
      (candidate) => { candidate.generatedCodeHash = "not-a-hash"; },
      (candidate) => { candidate.kind = "unknown"; },
    ];

    for (const mutate of cases) {
      const candidate = predicateCandidate();
      mutate(candidate);
      expect(() => parseReviewCandidate(candidate)).toThrow();
    }
  });

  test("renders stable Predicate and Static Judgment diffs", () => {
    expect(renderPredicateReviewDiff({
      previous: { kind: "equals", property: ["state"], value: "waiting" },
      candidate: { kind: "equals", property: ["state"], value: "ready" },
      typeSchema: {
        kind: "object",
        properties: [
          {
            name: "state",
            optional: false,
            type: {
              kind: "union",
              types: [
                { kind: "literal", value: "ready" },
                { kind: "literal", value: "waiting" },
              ],
            },
          },
        ],
      },
    })).toContain("Semantic change:");
    expect(renderStaticJudgmentReviewDiff({ previous: false, candidate: true }))
      .toBe("before: false\nafter: true\n");
  });
});

function predicateCandidate(): Record<string, any> {
  return {
    version: 1,
    id: "review-20260721000000-12345678",
    status: "ready",
    kind: "predicate",
    source: "predicate/semantic.ts",
    output: "predicate/is-ready.generated.ts",
    symbol: "isReady",
    conceptId: "customer.ready",
    provider: "fixture",
    model: "model",
    fingerprint: hash("fingerprint"),
    generatedCodeHash: hash("generated"),
    validation: {
      candidateTypecheck: "passed",
      projectTypecheck: "passed",
      semanticTest: "passed",
    },
    hashes: predicateHashes(),
    resolvedIr: { kind: "equals", property: ["state"], value: "ready" },
    baselineFingerprint: null,
    response: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    approvedAt: null,
    reviewer: null,
  };
}

function predicateHashes() {
  return {
    conceptHash: hash("concept"),
    sourceHash: hash("source"),
    typeHash: hash("type"),
    testHash: hash("test"),
    promptHash: hash("prompt"),
  };
}

function staticHashes() {
  return {
    conceptHash: hash("static-concept"),
    valueHash: hash("value"),
    promptHash: hash("static-prompt"),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "semantic-review-"));
  temporaryRoots.push(root);
  return root;
}
