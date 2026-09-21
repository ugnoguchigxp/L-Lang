import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishCollectionBottleneckEntries,
  regenerateCollectionBottleneckDecision,
  runCollectionBottleneckExperiment,
  validateRecordedMatrix,
} from "./llang-collection-bottleneck-experiment";
import { projectCollectionBottleneckMetrics } from "./llang-collection-bottleneck-metrics";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { stableJson } from "./stable-hash";
import { atomicWriteJson } from "./atomic-file";

const load = (path: string) => readFile(path, "utf8").then(JSON.parse);

describe("Collection bottleneck experiment", () => {
  test("regenerates the deterministic program and case evidence", async () => {
    const result = await runCollectionBottleneckExperiment(),
      deterministic = result.deterministic as {
        programs: unknown[];
        cases: unknown[];
      };
    expect(deterministic.programs).toHaveLength(9);
    expect(deterministic.cases).toHaveLength(23);
  });

  test("strict schemas accept the frozen inputs", async () => {
    for (const [schemaPath, valuePath] of [
      [
        "schemas/collection-bottleneck-benchmark-v1.schema.json",
        "benchmarks/collection-bottleneck-v1/benchmark.json",
      ],
      [
        "schemas/collection-bottleneck-workload-v1.schema.json",
        "benchmarks/collection-bottleneck-v1/workload.json",
      ],
      [
        "schemas/collection-bottleneck-observation-v1.schema.json",
        "benchmarks/collection-bottleneck-v1/observations/darwin-arm64.json",
      ],
      [
        "schemas/collection-bottleneck-decision-v1.schema.json",
        "benchmarks/collection-bottleneck-v1/decision.json",
      ],
    ] as const) {
      const schema = await load(schemaPath),
        value = await load(valuePath),
        validate = new Ajv2020({ strict: true, allErrors: true }).compile(
          schema,
        );
      expect(validate(value)).toBe(true);
    }
  });

  test("regenerates the exact decision from raw samples", async () => {
    const [recorded, regenerated] = await Promise.all([
      load("benchmarks/collection-bottleneck-v1/decision.json"),
      regenerateCollectionBottleneckDecision(),
    ]);
    expect(stableJson(regenerated)).toBe(stableJson(recorded));
  });

  test("rejects redistributed samples and unparseable metric input", async () => {
    const [observation, benchmark, workload, program] = await Promise.all([
        load(
          "benchmarks/collection-bottleneck-v1/observations/darwin-arm64.json",
        ),
        load("benchmarks/collection-bottleneck-v1/benchmark.json"),
        load("benchmarks/collection-bottleneck-v1/workload.json"),
        loadCollectionModuleProgram(
          "programs/fold.ts",
          "benchmarks/collection-binaryen-v1",
          "evaluate",
        ),
      ]),
      changed = structuredClone(observation),
      replacement = changed.samples.find(
        (row: { caseId: string }) => row.caseId === "fold-small-a",
      );
    replacement.caseId = "fold-medium-b";
    expect(() => validateRecordedMatrix(changed, benchmark, workload)).toThrow(
      "invalid matrix case",
    );
    expect(() =>
      projectCollectionBottleneckMetrics(
        program,
        '(module (func (export "evaluate") unknown.op))',
      ),
    ).toThrow("invalid WAT");
  });

  test("rolls back every published artifact when a later write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-bottleneck-publish-")),
      first = join(root, "first.json"),
      second = join(root, "second.json");
    try {
      await Promise.all([
        writeFile(first, "first-before\n"),
        writeFile(second, "second-before\n"),
      ]);
      let writes = 0;
      await expect(
        publishCollectionBottleneckEntries(
          root,
          [
            { path: "first.json", value: { changed: 1 } },
            { path: "second.json", value: { changed: 2 } },
          ],
          async (path, value) => {
            writes++;
            if (writes === 2) throw new Error("injected write failure");
            await atomicWriteJson(path, value);
          },
        ),
      ).rejects.toThrow("injected write failure");
      expect(await readFile(first, "utf8")).toBe("first-before\n");
      expect(await readFile(second, "utf8")).toBe("second-before\n");
      await expect(
        publishCollectionBottleneckEntries(root, [
          { path: "../escape.json", value: {} },
        ]),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
