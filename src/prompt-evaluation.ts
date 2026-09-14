import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { atomicWriteJson } from "./atomic-file";
import {
  makePromptResolver,
  proposePatch,
  type StructuredAgent,
} from "./prompt-agent";
import { resolvePromptSource } from "./prompt-resolution";
import {
  contentHash,
  createPromptSource,
  exampleInput,
  fail,
  identifier,
  list,
  parsePromptSource,
  readJson,
  stringValue,
  unique,
  updatePromptSource,
} from "./prompt-source";
import { buildPromptWasm } from "./prompt-wasm";
import { encodeInput, record, WasmError } from "./wasm-contract";
import { loadWasmPredicate } from "./wasm-runtime";

export function parseEvaluationDataset(input: unknown) {
  const d = record(input, ["version", "status", "cases"]);
  if (d.version !== 1 || d.status !== "draft")
    fail(
      "only draft harness datasets are supported; live evaluation requires independent review",
    );
  const cases = list(d.cases, "cases").map((value) => {
    const c = record(value, [
      "id",
      "source",
      "request",
      "allowedIds",
      "expectedOutcome",
      "probes",
    ]);
    const source = parsePromptSource(c.source);
    const allowedIds = list(c.allowedIds, "allowedIds").map(identifier);
    unique(allowedIds);
    if (!allowedIds.length) fail("allowedIds is empty");
    if (c.expectedOutcome !== "resolved" && c.expectedOutcome !== "unresolved")
      fail("invalid expected outcome");
    const probes = list(c.probes, "probes").map((value) => {
      const p = record(value, ["id", "input", "undefinedFields", "expected"]);
      if (typeof p.expected !== "boolean") fail("invalid probe expectation");
      const input = record(
        p.input,
        source.contract.fields.map((f) => f.name),
      );
      const undefinedFields = list(p.undefinedFields, "undefinedFields").map(
        (v) => stringValue(v, "field"),
      );
      unique(undefinedFields);
      const probe = {
        id: identifier(p.id),
        input,
        undefinedFields,
        expected: p.expected,
      };
      encodeInput(source.contract, exampleInput(probe));
      return probe;
    });
    unique(probes.map((p) => p.id));
    if ((c.expectedOutcome === "resolved") !== probes.length > 0)
      fail("resolved cases need probes; unresolved cases must have none");
    return {
      id: identifier(c.id),
      source,
      request: stringValue(c.request, "request"),
      allowedIds,
      expectedOutcome: c.expectedOutcome as "resolved" | "unresolved",
      probes,
    };
  });
  unique(cases.map((c) => c.id));
  if (!cases.length) fail("empty evaluation dataset");
  return { version: 1 as const, status: "draft" as const, cases };
}
export type EvaluationDataset = ReturnType<typeof parseEvaluationDataset>;
export type EvaluationCase = EvaluationDataset["cases"][number];
export type EvaluationResult = {
  id: string;
  expectedOutcome: "resolved" | "unresolved";
  outcome: "resolved" | "unresolved" | "rejected";
  stage: "patch" | "resolve" | "build" | "probes";
  passed: boolean;
  falseResolution: boolean;
  diagnostic: string | null;
  probes: { id: string; expected: boolean; actual: boolean }[];
};
export function parseEvaluationFixtures(
  input: unknown,
  dataset: EvaluationDataset,
) {
  const f = record(input, ["version", "responses"]);
  if (f.version !== 1) fail("unsupported fixture version");
  const responses = list(f.responses, "responses").map((v) => {
    const r = record(v, ["id", "patch", "resolution"]);
    return { id: identifier(r.id), patch: r.patch, resolution: r.resolution };
  });
  unique(responses.map((r) => r.id));
  if (
    responses.length !== dataset.cases.length ||
    responses.some((r) => !dataset.cases.some((c) => c.id === r.id))
  )
    fail("fixtures must match every case exactly");
  return responses;
}

async function runCase(
  c: EvaluationCase,
  directory: string,
  agent: StructuredAgent,
): Promise<EvaluationResult> {
  const path = resolve(directory, "source.json");
  const result: EvaluationResult = {
    id: c.id,
    expectedOutcome: c.expectedOutcome,
    outcome: "rejected",
    stage: "patch",
    passed: false,
    falseResolution: false,
    diagnostic: null,
    probes: [],
  };
  const { revision } = await createPromptSource(path, c.source);
  try {
    const patch = await proposePatch(agent, c.source, c.request, c.allowedIds);
    await updatePromptSource(path, revision, c.allowedIds, patch);
    result.stage = "resolve";
    await resolvePromptSource(path, makePromptResolver(agent));
    result.outcome = "resolved";
    result.falseResolution = c.expectedOutcome === "unresolved";
    result.stage = "build";
    const output = await buildPromptWasm(path, resolve(directory, "wasm"));
    const runtime = await loadWasmPredicate(output.manifest);
    result.stage = "probes";
    result.probes = c.probes.map((p) => ({
      id: p.id,
      expected: p.expected,
      actual: runtime.evaluate(exampleInput(p)),
    }));
    result.passed =
      c.expectedOutcome === "resolved" &&
      result.probes.every((p) => p.actual === p.expected);
    result.falseResolution = !result.passed;
    if (!result.passed)
      result.diagnostic = "resolved output violates the held-out oracle";
  } catch (e) {
    if (
      result.stage === "resolve" &&
      e instanceof WasmError &&
      e.code === "UNRESOLVED"
    ) {
      result.outcome = "unresolved";
      result.passed = c.expectedOutcome === "unresolved";
    }
    result.diagnostic = e instanceof Error ? e.message : String(e);
  }
  return result;
}

/** Fixture-only harness: outputs can never qualify as model-accuracy evidence. */
export async function runPromptEvaluation(
  datasetInput: unknown,
  fixtureInput: unknown,
  directory: string,
  expectedDatasetHash: string,
) {
  const dataset = parseEvaluationDataset(datasetInput);
  const datasetHash = contentHash(dataset);
  if (datasetHash !== expectedDatasetHash)
    fail("evaluation dataset hash differs from the pinned input");
  const fixtures = parseEvaluationFixtures(fixtureInput, dataset);
  // Reserve the whole run directory; never overwrite a prior report or checkpoint.
  await mkdir(dirname(resolve(directory)), { recursive: true });
  await mkdir(directory);
  await atomicWriteJson(resolve(directory, "dataset.json"), dataset);
  await atomicWriteJson(resolve(directory, "fixtures.json"), fixtureInput);
  const report = {
    version: 1,
    mode: "fixture",
    evidenceEligible: false,
    datasetHash,
    fixtureHash: contentHash(fixtureInput),
    apiCalls: 0,
    complete: false,
    passed: 0,
    failed: 0,
    falseResolutions: 0,
    results: [] as EvaluationResult[],
  };
  const reportPath = resolve(directory, "report.json");
  await atomicWriteJson(reportPath, report);
  for (const c of dataset.cases) {
    const fixture = fixtures.find((f) => f.id === c.id);
    if (!fixture) fail("missing fixture");
    let call = 0;
    const agent: StructuredAgent = async (_instruction, input) => {
      // The only model-facing values are those selected by proposePatch/makePromptResolver.
      if (
        Object.hasOwn(input as object, "probes") ||
        Object.hasOwn(input as object, "examples")
      )
        fail("oracle leaked to model input");
      call++;
      if (call > 2) fail("unexpected extra model call");
      return {
        result: call === 1 ? fixture.patch : fixture.resolution,
        provider: "fixture",
        model: "fixture",
        responseId: `${c.id}-${call}`,
        usage: null,
      };
    };
    const result = await runCase(c, resolve(directory, c.id), agent);
    report.results.push(result);
    report.passed += Number(result.passed);
    report.failed += Number(!result.passed);
    report.falseResolutions += Number(result.falseResolution);
    // Persist each completed case; an interrupted run remains explicitly incomplete.
    await atomicWriteJson(reportPath, report);
  }
  report.complete = true;
  await atomicWriteJson(reportPath, report);
  return report;
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "hash" && process.argv.length === 4) {
      console.log(
        contentHash(
          parseEvaluationDataset(await readJson(process.argv[3] as string)),
        ),
      );
    } else {
      const [
        datasetPath,
        fixturesFlag,
        fixturesPath,
        outputFlag,
        directory,
        hashFlag,
        hash,
        ...extra
      ] = process.argv.slice(2);
      if (
        !datasetPath ||
        fixturesFlag !== "--fixtures" ||
        !fixturesPath ||
        outputFlag !== "--out-dir" ||
        !directory ||
        hashFlag !== "--dataset-hash" ||
        !hash ||
        extra.length
      )
        fail(
          "usage: prompt:evaluate <dataset> --fixtures <file> --out-dir <new-directory> --dataset-hash <sha256>",
        );
      const result = await runPromptEvaluation(
        await readJson(datasetPath),
        await readJson(fixturesPath),
        directory,
        hash,
      );
      console.log(JSON.stringify(result, null, 2));
      if (result.failed) process.exitCode = 1;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
