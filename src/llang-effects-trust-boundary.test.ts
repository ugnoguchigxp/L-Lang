import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  analyzeEffectsProvenance,
  effectsObservedFlowSummary,
  parseEffectsStaticProvenance,
  parseEffectsTrustBoundary,
} from "./llang-effects-trust-boundary";
import type { CheckedEffectsGraph } from "./llang-module-effects-graph";
import {
  evaluateEffectsAdversarialFixture,
  parseEffectsAdversarialProtocol,
  readEffectsAdversarialProtocol,
} from "./llang-effects-adversarial-protocol";

const document = {
  format: "llang-effects-trust-boundary",
  version: 1,
  id: "fixture.boundary",
  revision: 1,
  requirements: {
    id: "fixture.requirements",
    revision: 1,
    commitmentHash: "a".repeat(64),
  },
  sources: [
    {
      id: "input",
      operation: "host.echo@1",
      responsePath: [],
      classification: "untrusted-data",
    },
  ],
  sinks: [
    {
      id: "output",
      operation: "host.echo@1",
      requestPath: [],
      classification: "external-output",
    },
  ],
  allowedFlows: [
    { source: "input", sink: "output", purpose: "fixture-roundtrip" },
  ],
  rules: {
    denyUnlistedFlows: true,
    denyDataDerivedAuthority: true,
    rawExternalDataInAudit: false,
  },
};

describe("Effects trust/data boundary", () => {
  test("strictly parses and resolves every declared source and sink", () => {
    const parsed = parseEffectsTrustBoundary(document),
      graph = {
        programHash: "b".repeat(64),
        program: {
          nodes: [
            {
              kind: "await",
              operation: "host.echo",
              version: 1,
              requestType: { kind: "string" },
              responseType: { kind: "i64" },
              request: "fixed",
            },
          ],
        },
      } as unknown as CheckedEffectsGraph,
      provenance = analyzeEffectsProvenance(parsed, graph);
    expect(provenance).toMatchObject({
      authorityDerivation: "static-not-data-derived",
      unlistedFlows: [],
      flows: [{ source: "input", sink: "output" }],
    });
    expect(() =>
      parseEffectsTrustBoundary({ ...document, extra: true }),
    ).toThrow("INVALID_EFFECTS_TRUST_BOUNDARY");
    expect(() =>
      parseEffectsTrustBoundary({
        ...document,
        allowedFlows: [{ source: "missing", sink: "output", purpose: "bad" }],
      }),
    ).toThrow("INVALID_EFFECTS_TRUST_BOUNDARY_FLOW");
    expect(() =>
      analyzeEffectsProvenance({ ...parsed, sources: [] }, graph),
    ).toThrow("EFFECTS_TRUST_BOUNDARY_SOURCE_COVERAGE");
    expect(() =>
      analyzeEffectsProvenance({ ...parsed, sinks: [] }, graph),
    ).toThrow("EFFECTS_TRUST_BOUNDARY_SINK_COVERAGE");
    expect(() =>
      analyzeEffectsProvenance({ ...parsed, allowedFlows: [] }, graph),
    ).toThrow("EFFECTS_TRUST_BOUNDARY_UNLISTED_FLOW");
    expect(() =>
      analyzeEffectsProvenance(
        parseEffectsTrustBoundary({
          ...document,
          sources: [{ ...document.sources[0], responsePath: ["missing"] }],
        }),
        graph,
      ),
    ).toThrow("EFFECTS_TRUST_BOUNDARY_SOURCE_NOT_FOUND");
    expect(parseEffectsStaticProvenance(provenance)).toEqual(provenance);
    expect(() =>
      parseEffectsStaticProvenance({ ...provenance, extra: true }),
    ).toThrow("INVALID_EFFECTS_STATIC_PROVENANCE");
  });

  test("covers record paths, concurrent tasks, and streams conservatively", () => {
    const endpoint = (id: string, operation: string) => ({
        id,
        operation,
        responsePath: ["value"],
        classification: "untrusted-data",
      }),
      sink = (id: string, operation: string) => ({
        id,
        operation,
        requestPath: ["value"],
        classification: "external-output",
      }),
      boundary = parseEffectsTrustBoundary({
        ...document,
        sources: [
          endpoint("stream-source", "host.stream@1"),
          endpoint("task-source", "host.task@1"),
        ],
        sinks: [
          sink("stream-sink", "host.stream@1"),
          sink("task-sink", "host.task@1"),
        ],
        allowedFlows: [
          { source: "stream-source", sink: "stream-sink", purpose: "stream" },
          { source: "task-source", sink: "stream-sink", purpose: "forward" },
          { source: "task-source", sink: "task-sink", purpose: "concurrent" },
        ],
      }),
      recordType = {
        kind: "record",
        fields: { value: { kind: "string" } },
      } as const,
      graph = {
        programHash: "c".repeat(64),
        program: {
          nodes: [
            {
              kind: "task",
              tasks: [
                {
                  kind: "await",
                  operation: "host.task",
                  version: 1,
                  requestType: recordType,
                  responseType: recordType,
                  request: { value: "fixed" },
                },
              ],
              responseType: { kind: "list", element: recordType },
            },
            {
              kind: "stream",
              operation: "host.stream",
              version: 1,
              requestType: recordType,
              responseType: recordType,
              request: { value: "fixed" },
              maximumChunks: 2,
            },
          ],
        },
      } as unknown as CheckedEffectsGraph;
    const provenance = analyzeEffectsProvenance(boundary, graph),
      observed = effectsObservedFlowSummary(
        {
          path: "fixture",
          fileIdentity: { dev: 1, ino: 1 },
          sourceHash: "d".repeat(64),
          commitmentHash: provenance.boundaryCommitmentHash,
          document: boundary,
          provenance,
          provenanceHash: "e".repeat(64),
        },
        [
          {
            sequence: 1,
            kind: "request",
            requestId: "stream-1",
            operation: "host.stream@1",
            previousHash: "0".repeat(64),
            eventHash: "1".repeat(64),
          },
          {
            sequence: 2,
            kind: "stream-chunk",
            requestId: "stream-1",
            chunk: 0,
            eof: false,
            previousHash: "1".repeat(64),
            eventHash: "2".repeat(64),
          },
        ],
      );
    expect(provenance.flows).toHaveLength(3);
    expect(observed.sources).toContainEqual({
      id: "stream-source",
      operation: "host.stream@1",
      observed: true,
    });
  });

  test("freezes a fair offline protocol and rejects incomplete results", async () => {
    const parsed = await readEffectsAdversarialProtocol(
        join(
          import.meta.dir,
          "../benchmarks/effects-trust-boundary-v1/protocol.json",
        ),
      ),
      observations = parsed.document.arms.flatMap((arm) =>
        parsed.document.cases.map((item) => ({
          arm: arm.id,
          caseId: item.id,
          taskCompleted: item.expectTaskCompleted,
          violationBlocked: item.expectViolationBlocked,
          incomplete: false,
        })),
      ),
      result = evaluateEffectsAdversarialFixture(parsed.document, observations);
    expect(result).toMatchObject({
      evidenceEligible: false,
      humanEvaluation: "not-run",
      liveEvaluation: "not-run",
      apiCalls: 0,
      arms: [
        { id: "llang", falseRejections: 0, oracleMismatches: 0 },
        { id: "typescript", falseRejections: 0, oracleMismatches: 0 },
      ],
    });
    expect(() =>
      evaluateEffectsAdversarialFixture(parsed.document, observations.slice(1)),
    ).toThrow("INCOMPLETE_EFFECTS_ADVERSARIAL_RESULTS");
    expect(() =>
      parseEffectsAdversarialProtocol({
        ...parsed.document,
        arms: [
          parsed.document.arms[0],
          { ...parsed.document.arms[1], hostProfile: "weaker-host" },
        ],
      }),
    ).toThrow("UNFAIR_EFFECTS_ADVERSARIAL_BASELINE");
    expect(() =>
      parseEffectsAdversarialProtocol({
        ...parsed.document,
        cases: parsed.document.cases.map((item, index) =>
          index === 0 ? { ...item, normal: !item.normal } : item,
        ),
      }),
    ).toThrow("EFFECTS_ADVERSARIAL_PROTOCOL_FREEZE_MISMATCH");
    for (const attack of parsed.document.cases) {
      const mutated = observations.map((observation) =>
          observation.caseId === attack.id
            ? { ...observation, taskCompleted: !observation.taskCompleted }
            : observation,
        ),
        evaluated = evaluateEffectsAdversarialFixture(parsed.document, mutated);
      expect(evaluated.arms.every((arm) => arm.oracleMismatches === 1)).toBe(
        true,
      );
    }
    const duplicate = observations[0];
    expect(duplicate).toBeDefined();
    if (!duplicate) throw new Error("missing fixture observation");
    expect(() =>
      evaluateEffectsAdversarialFixture(parsed.document, [
        ...observations.slice(0, -1),
        duplicate,
      ]),
    ).toThrow("INCOMPLETE_EFFECTS_ADVERSARIAL_RESULTS");
  });
});
