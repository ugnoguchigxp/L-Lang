import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parseEvaluationDataset,
  runPromptEvaluation,
} from "./prompt-evaluation";
import { contentHash, readJson } from "./prompt-source";

const root = resolve(import.meta.dir, "../benchmarks/prompt-source");
const dataset = parseEvaluationDataset(
  await readJson(resolve(root, "dataset.json")),
);
const fixtures = await readJson(resolve(root, "responses.fixture.json"));
const hash = contentHash(dataset);
async function temporary(run: (path: string) => Promise<void>) {
  const parent = await mkdtemp(resolve(tmpdir(), "prompt-eval-"));
  try {
    await run(resolve(parent, "run"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
test("evaluation runs updates and unresolved cases, checkpoints results, never claims live evidence", () =>
  temporary(async (path) => {
    const report = await runPromptEvaluation(dataset, fixtures, path, hash);
    expect(report).toMatchObject({
      complete: true,
      passed: 4,
      failed: 0,
      falseResolutions: 0,
      evidenceEligible: false,
      apiCalls: 0,
    });
    expect(report.results.map((r) => r.outcome)).toEqual([
      "resolved",
      "resolved",
      "unresolved",
      "unresolved",
    ]);
    expect(
      JSON.parse(await readFile(resolve(path, "report.json"), "utf8")),
    ).toEqual(report);
    const updated = await readJson(
      resolve(path, "suspension-update/source.json"),
    );
    expect(updated).toMatchObject({
      requirements: [
        dataset.cases[0]?.source.requirements[0],
        {
          id: "suspension",
          level: "must",
          text: "suspendedがfalseであること。",
        },
      ],
    });
    await expect(
      runPromptEvaluation(dataset, fixtures, path, hash),
    ).rejects.toThrow();
  }));
test("held-out oracle detects a wrong predicate that passes source examples", () =>
  temporary(async (path) => {
    const altered = structuredClone(fixtures) as {
      responses: { resolution: unknown }[];
    };
    const first = altered.responses[0];
    if (!first) throw new Error("missing fixture");
    first.resolution = {
      outcome: "resolved",
      body: { kind: "equals", property: ["enabled"], value: true },
      diagnostics: [],
    };
    const report = await runPromptEvaluation(dataset, altered, path, hash);
    expect(report).toMatchObject({
      passed: 3,
      failed: 1,
      falseResolutions: 1,
      complete: true,
    });
    expect(report.results[0]).toMatchObject({
      outcome: "resolved",
      stage: "probes",
      passed: false,
    });
  }));
test("malformed output is a rejection, not a successful unresolved answer", () =>
  temporary(async (path) => {
    const altered = structuredClone(fixtures) as {
      responses: { resolution: unknown }[];
    };
    const third = altered.responses[2];
    if (!third) throw new Error("missing fixture");
    third.resolution = {
      outcome: "unresolved",
      body: { kind: "equals", property: ["enabled"], value: true },
      diagnostics: [],
    };
    const report = await runPromptEvaluation(dataset, altered, path, hash);
    expect(report.results[2]).toMatchObject({
      outcome: "rejected",
      passed: false,
      stage: "resolve",
      falseResolution: false,
    });
    expect(report.failed).toBe(1);
  }));
test("evaluation rejects changed inputs and fixture coverage before writing", () =>
  temporary(async (path) => {
    await expect(
      runPromptEvaluation(dataset, fixtures, path, "0".repeat(64)),
    ).rejects.toThrow("pinned input");
    await expect(
      runPromptEvaluation(dataset, { version: 1, responses: [] }, path, hash),
    ).rejects.toThrow("every case");
    await expect(readFile(resolve(path, "report.json"))).rejects.toThrow();
    expect(() =>
      parseEvaluationDataset({ ...dataset, status: "approved" }),
    ).toThrow("draft");
    expect(() =>
      parseEvaluationDataset({
        ...dataset,
        cases: [dataset.cases[0], dataset.cases[0]],
      }),
    ).toThrow("duplicate");
  }));
test("an out-of-scope patch is rejected without reaching resolution", () =>
  temporary(async (path) => {
    const altered = structuredClone(fixtures) as {
      responses: { patch: unknown }[];
    };
    const first = altered.responses[0];
    if (!first) throw new Error("missing fixture");
    first.patch = { changes: [{ id: "enabled", replacement: null }] };
    const report = await runPromptEvaluation(dataset, altered, path, hash);
    expect(report.results[0]).toMatchObject({
      outcome: "rejected",
      stage: "patch",
      passed: false,
    });
    await expect(
      readFile(resolve(path, "suspension-update/source.json.lock.json")),
    ).rejects.toThrow();
  }));
