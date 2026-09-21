import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020";
import {
  regenerateCollectionStabilityDecision,
  withCollectionStabilityRecordLock,
} from "./llang-collection-stability-experiment";
import { validateCollectionStabilityMatrix } from "./llang-collection-stability-report";
import { stableJson } from "./stable-hash";

const load = (path: string) => readFile(path, "utf8").then(JSON.parse);

describe("Collection runtime stability experiment", () => {
  test("accepts every frozen artifact and regenerates the exact decision", async () => {
    for (const [kind, valuePath] of [
      [
        "benchmark",
        "benchmarks/collection-runtime-stability-v1/benchmark.json",
      ],
      ["workload", "benchmarks/collection-runtime-stability-v1/workload.json"],
      [
        "observation",
        "benchmarks/collection-runtime-stability-v1/observations/darwin-arm64.json",
      ],
      ["decision", "benchmarks/collection-runtime-stability-v1/decision.json"],
    ] as const) {
      const schema = await load(
          `schemas/collection-runtime-stability-${kind}-v1.schema.json`,
        ),
        value = await load(valuePath),
        validate = new Ajv2020({ strict: true, allErrors: true }).compile(
          schema,
        );
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }
    const recorded = await load(
        "benchmarks/collection-runtime-stability-v1/decision.json",
      ),
      regenerated = await regenerateCollectionStabilityDecision();
    expect(stableJson(regenerated)).toBe(stableJson(recorded));
  });

  test("keeps the v1 source immutable and rejects an incomplete matrix", async () => {
    const [observation, source, benchmark] = await Promise.all([
        load(
          "benchmarks/collection-runtime-stability-v1/observations/darwin-arm64.json",
        ),
        load("benchmarks/collection-bottleneck-v1/workload.json"),
        load("benchmarks/collection-runtime-stability-v1/benchmark.json"),
      ]),
      sourceBytes = await readFile(
        "benchmarks/collection-bottleneck-v1/observations/darwin-arm64.json",
      ),
      hash = createHash("sha256").update(sourceBytes).digest("hex");
    expect(observation.sourceObservationHash).toBe(hash);
    expect(() =>
      validateCollectionStabilityMatrix(
        observation.samples.slice(1),
        source.cases.map((item: { id: string }) => item.id),
        benchmark.blocks,
        benchmark.samples,
      ),
    ).toThrow("incomplete matrix");
  });

  test("rejects concurrent record publication", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      first = withCollectionStabilityRecordLock(() => gate);
    await Bun.sleep(10);
    await expect(
      withCollectionStabilityRecordLock(async () => undefined),
    ).rejects.toThrow("already running");
    release?.();
    await first;
  });
});
