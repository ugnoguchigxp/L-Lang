import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020";
import {
  assertLlvmSampleMatrix,
  decideLlvmExperiment,
  summarizeLlvmSamples,
  type LlvmExperimentSample,
} from "./llang-llvm-report";
import { extractLlvmKernelPlan } from "./llang-llvm-kernel-ir";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { assertCollectionWasmBinary } from "./llang-module-collection-runtime";
import { validateLlvmCorpus } from "./llang-llvm-experiment";
import { emitDirectKernelWasm } from "./llang-llvm-wasm";

const load = (path: string) => readFile(path, "utf8").then(JSON.parse);

describe("LLVM experiment evidence", () => {
  test("checked-in evidence satisfies schemas and regenerates from raw samples", async () => {
    const schemaNames = [
        "llvm-experiment-benchmark-v1.schema.json",
        "llvm-experiment-freeze-v1.schema.json",
        "llvm-experiment-observation-v1.schema.json",
        "llvm-experiment-decision-v1.schema.json",
      ],
      schemas = await Promise.all(
        schemaNames.map((name) => load(`schemas/${name}`)),
      ),
      ajv = new Ajv2020({ strict: true, allErrors: true });
    for (const schema of schemas) ajv.addSchema(schema);
    const [freeze, observation, decision, corpus] = await Promise.all([
      load("benchmarks/llvm-backend-v1/freeze.json"),
      load("benchmarks/llvm-backend-v1/observations/darwin-arm64.json"),
      load("benchmarks/llvm-backend-v1/decision.json"),
      load("benchmarks/llvm-backend-v1/corpus.json"),
    ]);
    for (const [schema, value] of [
      [schemas[1], freeze],
      [schemas[2], observation],
      [schemas[3], decision],
    ])
      expect(ajv.getSchema(schema.$id)?.(value)).toBe(true);
    assertLlvmSampleMatrix(
      observation.samples as LlvmExperimentSample[],
      corpus.cases.filter(
        (item: { partition: string }) => item.partition !== "correctness",
      ),
      observation.benchmark.samples,
      observation.benchmark.optimizations,
    );
    expect(
      summarizeLlvmSamples(observation.samples as LlvmExperimentSample[]),
    ).toEqual(observation.summary);
    expect(
      decideLlvmExperiment(
        observation.summary,
        freeze.artifacts,
        observation.benchmark,
      ),
    ).toEqual(decision);
  });

  test("experimental kernel Wasm cannot pass the product artifact verifier", async () => {
    const program = await loadCollectionModuleProgram(
        "application/evaluate.llang.jsonc",
        "examples/llvm-sum-i32",
        "evaluate",
      ),
      experimental = emitDirectKernelWasm(extractLlvmKernelPlan(program));
    expect(() => assertCollectionWasmBinary(experimental.bytes)).toThrow(
      "unexpected collection Wasm interface",
    );
  });

  test("rejects mixed scopes and incomplete decision evidence", () => {
    const invalidScope: LlvmExperimentSample = {
      caseId: "holdout-medium",
      partition: "holdout",
      lane: "direct-wasm",
      sample: 0,
      scope: "end-to-end",
      nsPerIteration: 10,
    };
    expect(() => summarizeLlvmSamples([invalidScope])).toThrow(
      "must use kernel scope",
    );

    expect(() =>
      decideLlvmExperiment(
        [
          {
            caseId: "holdout-medium",
            partition: "holdout",
            lane: "direct-wasm",
            scope: "kernel",
            medianNs: 10,
            madNs: 0,
            p95Ns: 10,
          },
        ],
        [
          { lane: "product-wasm", bytes: 100 },
          { lane: "direct-wasm", bytes: 100 },
          { lane: "llvm-wasm-O0", bytes: 100 },
          { lane: "llvm-native-O0", bytes: 100 },
        ],
        {
          optimizations: ["O0"],
          decision: {
            maximumMedianRegressionPercent: 5,
            requiredImprovementPercent: 10,
            maximumArtifactRatio: 2,
          },
        },
      ),
    ).toThrow("missing llvm-wasm-O0 holdout cases");
  });

  test("applies performance gates before rounding displayed percentages", () => {
    const row = (
      caseId: string,
      lane: "direct-wasm" | "llvm-wasm-O0",
      medianNs: number,
    ) => ({
      caseId,
      partition: "holdout" as const,
      lane,
      scope: "kernel" as const,
      medianNs,
      madNs: 0,
      p95Ns: medianNs,
    });
    const decision = decideLlvmExperiment(
      [
        row("holdout-small", "direct-wasm", 10_000),
        row("holdout-medium", "direct-wasm", 10_000),
        row("holdout-small", "llvm-wasm-O0", 10_500.04),
        row("holdout-medium", "llvm-wasm-O0", 8_000),
      ],
      [
        { lane: "product-wasm", bytes: 100 },
        { lane: "direct-wasm", bytes: 100 },
        { lane: "llvm-wasm-O0", bytes: 100 },
        { lane: "llvm-native-O0", bytes: 100 },
      ],
      {
        optimizations: ["O0"],
        decision: {
          maximumMedianRegressionPercent: 5,
          requiredImprovementPercent: 10,
          maximumArtifactRatio: 2,
        },
      },
    );
    expect(decision.outcome).toBe("maintain-current-backend");
    expect(decision.wasmCandidates).toEqual([
      expect.objectContaining({ qualifies: false }),
    ]);
  });

  test("rejects an incomplete or relabeled frozen corpus", async () => {
    const corpus = (await load(
      "benchmarks/llvm-backend-v1/corpus.json",
    )) as Parameters<typeof validateLlvmCorpus>[0];
    validateLlvmCorpus(corpus);

    const missing = structuredClone(corpus);
    missing.cases.pop();
    expect(() => validateLlvmCorpus(missing)).toThrow(
      "incomplete frozen case matrix",
    );

    const relabeled = structuredClone(corpus);
    const holdout = relabeled.cases.find(
      (item) => item.id === "holdout-medium",
    );
    if (!holdout) throw new Error("missing test fixture");
    holdout.partition = "exploration";
    expect(() => validateLlvmCorpus(relabeled)).toThrow(
      "incomplete frozen case matrix",
    );

    const wrongBoundary = structuredClone(corpus);
    const boundary = wrongBoundary.wasmBoundaryCases[0];
    if (!boundary) throw new Error("missing boundary fixture");
    boundary.expectedStatus = 2;
    expect(() => validateLlvmCorpus(wrongBoundary)).toThrow(
      "incorrect boundary",
    );
  });
});
