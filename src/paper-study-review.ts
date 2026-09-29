import {
  loadStudyInputs,
  validateLoadedStudy,
  type LoadedStudyInputs,
} from "./paper-study-inputs";
import { contentHash, readJson } from "./prompt-source";

const checks = [
  "requirements",
  "expressibility",
  "unresolved",
  "inputBoundaries",
  "taskOverlap",
] as const;
type Check = (typeof checks)[number];
type Decision = "pending" | "pass" | "fail";
type TaskReview = {
  taskId: string;
  sourceAuthors: string[] | null;
  oracleAuthors: string[] | null;
  reviewer: string | null;
  independent: boolean | null;
  reviewedAt: string | null;
  recordReference: string | null;
  checks: Record<Check, Decision>;
  findings: { check: Check; note: string }[];
};
export type StudyReviewRecord = {
  version: 1;
  format: "llang-paper-study-review";
  studyId: string;
  studyHash: string;
  inputHashes: Record<string, string>;
  tasks: TaskReview[];
};
type ReviewHooks = { afterInputsLoaded?: () => void | Promise<void> };
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const clean = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const nullable = (value: unknown, check: (value: unknown) => boolean) =>
  value === null || check(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const authorList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(clean) &&
  new Set(value).size === value.length;
const validDate = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return false;
  const time = new Date(value);
  return !Number.isNaN(time.valueOf()) && time.toISOString() === value;
};

export function createStudyReviewTemplate(
  loaded: LoadedStudyInputs,
): StudyReviewRecord {
  const validation = validateLoadedStudy(loaded);
  return {
    version: 1,
    format: "llang-paper-study-review",
    studyId: loaded.study.id,
    studyHash: validation.studyHash,
    inputHashes: { ...validation.hashes },
    tasks: loaded.study.tasks.map((task) => ({
      taskId: task.id,
      sourceAuthors: null,
      oracleAuthors: null,
      reviewer: null,
      independent: null,
      reviewedAt: null,
      recordReference: null,
      checks: Object.fromEntries(
        checks.map((key) => [key, "pending"]),
      ) as Record<Check, Decision>,
      findings: [],
    })),
  };
}

export function parseStudyReviewRecord(value: unknown): StudyReviewRecord {
  if (
    !isObject(value) ||
    !exact(value, [
      "version",
      "format",
      "studyId",
      "studyHash",
      "inputHashes",
      "tasks",
    ]) ||
    value.version !== 1 ||
    value.format !== "llang-paper-study-review" ||
    !clean(value.studyId) ||
    !hash(value.studyHash) ||
    !isObject(value.inputHashes) ||
    !Array.isArray(value.tasks)
  )
    throw new Error("invalid study review record");
  for (const [key, digest] of Object.entries(value.inputHashes))
    if (
      !/^[A-Za-z0-9_-]+:(source|metadata|oracle|fixture)$/.test(key) ||
      !hash(digest)
    )
      throw new Error("invalid study review input hash");
  const taskIds = new Set<string>();
  for (const task of value.tasks) {
    if (
      !isObject(task) ||
      !exact(task, [
        "taskId",
        "sourceAuthors",
        "oracleAuthors",
        "reviewer",
        "independent",
        "reviewedAt",
        "recordReference",
        "checks",
        "findings",
      ]) ||
      !clean(task.taskId) ||
      !/^[A-Za-z0-9_-]+$/.test(task.taskId) ||
      taskIds.has(task.taskId) ||
      !nullable(task.sourceAuthors, authorList) ||
      !nullable(task.oracleAuthors, authorList) ||
      !nullable(task.reviewer, clean) ||
      !nullable(task.independent, (v) => typeof v === "boolean") ||
      !nullable(task.reviewedAt, validDate) ||
      !nullable(task.recordReference, clean) ||
      !isObject(task.checks) ||
      !exact(task.checks, [...checks]) ||
      !checks.every((key) => {
        const decision = (task.checks as Record<string, unknown>)[key];
        return (
          decision === "pending" || decision === "pass" || decision === "fail"
        );
      }) ||
      !Array.isArray(task.findings)
    )
      throw new Error("invalid study review task");
    taskIds.add(task.taskId);
    for (const finding of task.findings) {
      if (
        !isObject(finding) ||
        !exact(finding, ["check", "note"]) ||
        !checks.includes(finding.check as Check) ||
        !clean(finding.note)
      )
        throw new Error("invalid study review finding");
    }
    for (const key of checks)
      if (
        (task.checks as Record<string, unknown>)[key] === "fail" &&
        !task.findings.some(
          (finding: { check?: string }) => finding.check === key,
        )
      )
        throw new Error(
          `study review failed check lacks a finding: ${task.taskId}/${key}`,
        );
  }
  return value as StudyReviewRecord;
}

export function verifyStudyReviewRecord(
  value: unknown,
  loaded: LoadedStudyInputs,
) {
  const record = parseStudyReviewRecord(value);
  const validation = validateLoadedStudy(loaded);
  if (validation.diagnostics.length)
    throw new Error(
      `study review input invalid: ${validation.diagnostics.join("; ")}`,
    );
  const expectedHashes = validation.hashes;
  if (
    record.studyId !== loaded.study.id ||
    record.studyHash !== validation.studyHash ||
    Object.keys(record.inputHashes).length !==
      Object.keys(expectedHashes).length ||
    Object.entries(expectedHashes).some(
      ([key, value]) => record.inputHashes[key] !== value,
    ) ||
    record.tasks.length !== loaded.study.tasks.length ||
    record.tasks.some(
      (task, index) => task.taskId !== loaded.study.tasks[index]?.id,
    )
  )
    throw new Error("study review target hash or task plan mismatch");
  const tasks = record.tasks.map((task) => {
    const reasons = new Set<string>();
    const decisions = Object.values(task.checks);
    if (decisions.includes("fail")) reasons.add("checks-failed");
    if (decisions.includes("pending")) reasons.add("checks-pending");
    if (!task.sourceAuthors || !task.oracleAuthors)
      reasons.add("authors-missing");
    if (!task.reviewer) reasons.add("reviewer-missing");
    if (task.independent === null) reasons.add("independence-unconfirmed");
    if (task.independent === false) reasons.add("independence-declined");
    if (
      task.reviewer &&
      (task.sourceAuthors?.includes(task.reviewer) ||
        task.oracleAuthors?.includes(task.reviewer))
    )
      reasons.add("reviewer-is-author");
    if (!task.reviewedAt) reasons.add("reviewed-at-missing");
    if (!task.recordReference) reasons.add("reference-missing");
    const status =
      reasons.has("checks-failed") ||
      reasons.has("independence-declined") ||
      reasons.has("reviewer-is-author")
        ? ("changes-requested" as const)
        : reasons.size
          ? ("pending" as const)
          : ("accepted" as const);
    return { taskId: task.taskId, status, reasons: [...reasons].sort() };
  });
  const status = tasks.some((task) => task.status === "changes-requested")
    ? ("changes-requested" as const)
    : tasks.some((task) => task.status === "pending")
      ? ("pending" as const)
      : ("accepted" as const);
  return {
    version: 1 as const,
    format: "llang-paper-study-review-verification" as const,
    studyId: record.studyId,
    studyHash: record.studyHash,
    recordHash: contentHash(record),
    status,
    tasks,
    evidenceEligible: false as const,
  };
}

export async function verifyStudyReview(
  studyPath: string,
  recordPath: string,
  hooks: ReviewHooks = {},
) {
  const record = parseStudyReviewRecord(await readJson(recordPath));
  const loaded = await loadStudyInputs(studyPath);
  await hooks.afterInputsLoaded?.();
  return verifyStudyReviewRecord(record, loaded);
}
