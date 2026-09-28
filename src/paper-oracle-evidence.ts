import { link, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  type DevelopmentRun,
  parseDevelopmentRun,
} from "./capability-development";
import { readCapability } from "./capability-package";
import { resolveContainedFile } from "./contained-path";
import { parsePaperOracle } from "./paper-evaluate";
import type { StudyRun, Trial } from "./paper-study-validation";
import { contentHash } from "./prompt-source";
import { digest, WasmError } from "./wasm-contract";

type Oracle = ReturnType<typeof parsePaperOracle>;
type Expected = Oracle["cases"][number]["expected"];
export type Actual =
  | { kind: "value"; value: boolean }
  | { kind: "error"; code: "INVALID_INPUT" }
  | { kind: "execution-error"; code: "EXECUTION_ERROR" }
  | { kind: "not-run"; reason: "prior-execution-error" };
type Case = {
  id: string;
  inputHash: string;
  expected: Expected;
  actual: Actual;
  status: "pass" | "fail" | "error" | "not-run";
};
export type OracleEvidence = {
  version: 1;
  format: "llang-paper-oracle-evidence";
  studyHash: string;
  trialId: string;
  taskId: string;
  sourceHash: string;
  metadataHash: string;
  developmentHash: string;
  attemptIndex: number;
  candidatePath: string;
  packageHash: string;
  wasmHash: string;
  contractHash: string;
  oracleHash: string;
  oracle: Oracle;
  cases: Case[];
  result: "pass" | "fail" | "error";
  checksum: string;
};
const hash = (x: unknown) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x: Record<string, unknown>, fields: string[]) =>
  Object.keys(x).length === fields.length &&
  fields.every((f) => Object.hasOwn(x, f));
const fields = [
  "version",
  "format",
  "studyHash",
  "trialId",
  "taskId",
  "sourceHash",
  "metadataHash",
  "developmentHash",
  "attemptIndex",
  "candidatePath",
  "packageHash",
  "wasmHash",
  "contractHash",
  "oracleHash",
  "oracle",
  "cases",
  "result",
  "checksum",
];
export const oracleEvidencePath = (trialId: string) =>
  `${trialId}/oracle-evidence.json`;
export const candidatePath = (trialId: string, index: number) =>
  `${trialId}/attempt-${index}/candidate/capability.json`;
export function caseStatus(expected: Expected, actual: Actual): Case["status"] {
  if (actual.kind === "execution-error") return "error";
  if (actual.kind === "not-run") return "not-run";
  return expected.kind === actual.kind &&
    (expected.kind === "value"
      ? actual.kind === "value" && expected.value === actual.value
      : actual.kind === "error" && expected.code === actual.code)
    ? "pass"
    : "fail";
}
export function resultOf(cases: Case[]): OracleEvidence["result"] {
  return cases.some((c) => c.status === "error")
    ? "error"
    : cases.some((c) => c.status === "fail")
      ? "fail"
      : "pass";
}
export function evaluateCases(
  oracle: Oracle,
  evaluate: (input: unknown) => boolean,
): Case[] {
  let stopped = false;
  return oracle.cases.map((c) => {
    let actual: Actual;
    if (stopped) actual = { kind: "not-run", reason: "prior-execution-error" };
    else
      try {
        actual = { kind: "value", value: evaluate(c.input) };
      } catch (error) {
        actual =
          error instanceof WasmError && error.code === "INVALID_INPUT"
            ? { kind: "error", code: "INVALID_INPUT" }
            : { kind: "execution-error", code: "EXECUTION_ERROR" };
        if (actual.kind === "execution-error") stopped = true;
      }
    return {
      id: c.id,
      inputHash: contentHash(c.input),
      expected: c.expected,
      actual,
      status: caseStatus(c.expected, actual),
    };
  });
}
export function createOracleEvidence(
  run: StudyRun,
  trial: Trial,
  developmentRaw: unknown,
  development: DevelopmentRun,
  pkg: Awaited<ReturnType<typeof readCapability>>,
  oracle: Oracle,
  cases: Case[],
): OracleEvidence {
  const last = development.attempts.at(-1);
  if (
    last?.status !== "pass" ||
    !Number.isSafeInteger(last.index) ||
    last.index < 0
  )
    throw new Error("invalid final attempt");
  const unsigned = {
    version: 1 as const,
    format: "llang-paper-oracle-evidence" as const,
    studyHash: run.studyHash,
    trialId: trial.id,
    taskId: trial.taskId,
    sourceHash: trial.sourceHash,
    metadataHash: trial.metadataHash,
    developmentHash: contentHash(developmentRaw),
    attemptIndex: last.index,
    candidatePath: candidatePath(trial.id, last.index),
    packageHash: pkg.packageHash,
    wasmHash: digest(pkg.bytes),
    contractHash: contentHash(pkg.build.contract),
    oracleHash: contentHash(oracle),
    oracle,
    cases,
    result: resultOf(cases),
  };
  return { ...unsigned, checksum: contentHash(unsigned) };
}
export function parseOracleEvidence(value: unknown): OracleEvidence {
  if (!object(value) || !exact(value, fields))
    throw new Error("invalid Oracle evidence fields");
  const { checksum, ...unsigned } = value;
  if (
    value.version !== 1 ||
    value.format !== "llang-paper-oracle-evidence" ||
    !hash(checksum) ||
    checksum !== contentHash(unsigned) ||
    !Number.isSafeInteger(value.attemptIndex) ||
    (value.attemptIndex as number) < 0 ||
    typeof value.trialId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value.trialId) ||
    typeof value.taskId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value.taskId) ||
    value.candidatePath !==
      candidatePath(value.trialId, value.attemptIndex as number) ||
    !["pass", "fail", "error"].includes(String(value.result)) ||
    [
      "studyHash",
      "sourceHash",
      "metadataHash",
      "developmentHash",
      "packageHash",
      "wasmHash",
      "contractHash",
      "oracleHash",
    ].some((f) => !hash(value[f]))
  )
    throw new Error("invalid Oracle evidence header");
  const oracle = parsePaperOracle(value.oracle);
  if (
    contentHash(oracle) !== value.oracleHash ||
    !Array.isArray(value.cases) ||
    value.cases.length !== oracle.cases.length
  )
    throw new Error("Oracle evidence cases mismatch");
  let stopped = false;
  for (let i = 0; i < oracle.cases.length; i++) {
    const source = oracle.cases[i];
    if (!source) throw new Error("Oracle evidence case mismatch");
    const c = value.cases[i];
    if (
      !object(c) ||
      !exact(c, ["id", "inputHash", "expected", "actual", "status"]) ||
      c.id !== source.id ||
      c.inputHash !== contentHash(source.input) ||
      contentHash(c.expected) !== contentHash(source.expected) ||
      !object(c.actual)
    )
      throw new Error("Oracle evidence case mismatch");
    const a = c.actual;
    const valid =
      a.kind === "value"
        ? exact(a, ["kind", "value"]) && typeof a.value === "boolean"
        : a.kind === "error"
          ? exact(a, ["kind", "code"]) && a.code === "INVALID_INPUT"
          : a.kind === "execution-error"
            ? exact(a, ["kind", "code"]) && a.code === "EXECUTION_ERROR"
            : a.kind === "not-run"
              ? exact(a, ["kind", "reason"]) &&
                a.reason === "prior-execution-error"
              : false;
    if (
      !valid ||
      (stopped ? a.kind !== "not-run" : a.kind === "not-run") ||
      c.status !== caseStatus(source.expected, a as Actual)
    )
      throw new Error("Oracle evidence result mismatch");
    if (a.kind === "execution-error") stopped = true;
  }
  if (value.result !== resultOf(value.cases as Case[]))
    throw new Error("Oracle evidence aggregate mismatch");
  return value as OracleEvidence;
}
export async function verifyOracleEvidenceBody(
  runDir: string,
  run: StudyRun,
  trial: Trial,
  raw: unknown,
  developmentRaw: unknown,
  development: DevelopmentRun,
  oracle: Oracle,
) {
  const evidence = parseOracleEvidence(raw);
  if (
    contentHash(parseDevelopmentRun(developmentRaw)) !==
    contentHash(development)
  )
    throw new Error("Oracle evidence development mismatch");
  if (
    trial.status !== "pass" ||
    development.status !== "pass" ||
    !development.complete ||
    development.sourceHash !== trial.sourceHash ||
    development.metadataHash !== trial.metadataHash ||
    evidence.studyHash !== run.studyHash ||
    evidence.trialId !== trial.id ||
    evidence.taskId !== trial.taskId ||
    evidence.sourceHash !== trial.sourceHash ||
    evidence.metadataHash !== trial.metadataHash ||
    evidence.developmentHash !== contentHash(developmentRaw) ||
    evidence.oracleHash !== trial.oracleHash ||
    evidence.oracleHash !== contentHash(oracle)
  )
    throw new Error("Oracle evidence identity mismatch");
  const last = development.attempts.at(-1);
  if (
    last?.status !== "pass" ||
    evidence.attemptIndex !== last.index ||
    evidence.packageHash !== last.packageHash ||
    evidence.candidatePath !== candidatePath(trial.id, last.index)
  )
    throw new Error("Oracle evidence attempt mismatch");
  const pkg = await readCapability(
    await resolveContainedFile(
      runDir,
      evidence.candidatePath,
      "trial candidate",
      { rejectSymbolicLinks: true },
    ),
  );
  if (
    pkg.source.id !== trial.taskId ||
    contentHash(pkg.source) !== trial.sourceHash ||
    contentHash(pkg.manifest.metadata) !== trial.metadataHash ||
    pkg.packageHash !== evidence.packageHash ||
    pkg.lock.irHash !== last.irHash ||
    digest(pkg.bytes) !== evidence.wasmHash ||
    contentHash(pkg.build.contract) !== evidence.contractHash ||
    contentHash(evidence.oracle) !== contentHash(oracle)
  )
    throw new Error("Oracle evidence target mismatch");
  return evidence;
}
export function verifyOracleEvidenceCheckpoint(
  run: StudyRun,
  trial: Trial,
  evidence: OracleEvidence,
) {
  if (evidence.result === "error") {
    if (trial.oracleStatus !== "not-run" || run.status !== "uncertain")
      throw new Error("Oracle error checkpoint mismatch");
  } else if (trial.oracleStatus !== evidence.result)
    throw new Error("Oracle checkpoint mismatch");
}
export async function publishOracleEvidence(
  path: string,
  evidence: OracleEvidence,
  operations = { link, unlink },
) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  let preparationFailed = false;
  let preparationError: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
    await handle.sync();
  } catch (error) {
    preparationFailed = true;
    preparationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (!preparationFailed) {
      preparationFailed = true;
      preparationError = error;
    }
  }
  if (preparationFailed) {
    await operations.unlink(temp);
    throw preparationError;
  }
  try {
    await operations.link(temp, path);
  } finally {
    await operations.unlink(temp);
  }
}
