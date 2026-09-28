import { parseDevelopmentConfig } from "./capability-development";

export type StudyTask = {
  id: string;
  source: string;
  metadata: string;
  oracle: string;
  fixture?: string;
  features: string[];
  origin: string;
  review: "unreviewed" | "reviewed";
};
export type Study = {
  version: 1;
  id: string;
  state: "draft" | "frozen";
  review: "unreviewed" | "reviewed";
  approval: "not-granted" | "granted";
  profile: "predicate-i32-v1";
  repetitions: number;
  model: string | null;
  provider: "codex-sdk" | null;
  maxCalls: number;
  maxOutputTokens: number | null;
  maxTotalTokens: number | null;
  maxWallMs: number | null;
  budget: number | null;
  tasks: StudyTask[];
  unresolved: string[];
  frozenHashes?: Record<string, string>;
};
export type Trial = {
  id: string;
  taskId: string;
  status:
    | "pending"
    | "uncertain"
    | "pass"
    | "fail"
    | "unresolved"
    | "error"
    | "stopped";
  oracleStatus: "not-run" | "pass" | "fail";
  sourceHash: string;
  metadataHash: string;
  oracleHash: string;
  fixtureHash: string | null;
  development: string | null;
  calls: number;
  tokens: number;
  reason: string | null;
};
type StudyRunBase = {
  studyPath: string;
  studyHash: string;
  mode: "fixture" | "live";
  trials: Trial[];
  status: "running" | "complete" | "uncertain";
  approvalHash: string | null;
  approvalPath: string | null;
};
export type StudyRun =
  | (StudyRunBase & { version: 1 })
  | (StudyRunBase & { version: 2; inputSnapshotHash: string });
const record = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (
  x: Record<string, unknown>,
  allowed: string[],
  required: string[],
) =>
  Object.keys(x).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(x, key));
const str = (x: unknown): x is string =>
  typeof x === "string" && x.trim().length > 0;
const id = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9_-]+$/.test(x);
const integer = (x: unknown, min = 0): x is number =>
  Number.isSafeInteger(x) && (x as number) >= min;
const nullable = (x: unknown, check: (value: unknown) => boolean) =>
  x === null || check(x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(str);
const digest = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const taskKeys = [
  "id",
  "source",
  "metadata",
  "oracle",
  "fixture",
  "features",
  "origin",
  "review",
];
const studyKeys = [
  "version",
  "id",
  "state",
  "review",
  "approval",
  "profile",
  "repetitions",
  "model",
  "provider",
  "maxCalls",
  "maxOutputTokens",
  "maxTotalTokens",
  "maxWallMs",
  "budget",
  "tasks",
  "unresolved",
  "frozenHashes",
];
const trialKeys = [
  "id",
  "taskId",
  "status",
  "oracleStatus",
  "sourceHash",
  "metadataHash",
  "oracleHash",
  "fixtureHash",
  "development",
  "calls",
  "tokens",
  "reason",
];
const runKeys = [
  "version",
  "studyPath",
  "studyHash",
  "mode",
  "trials",
  "status",
  "approvalHash",
  "approvalPath",
];
const runV2Keys = [...runKeys, "inputSnapshotHash"];

export function parseStudy(value: unknown): Study {
  if (
    !record(value) ||
    !keys(
      value,
      studyKeys,
      studyKeys.filter((x) => x !== "frozenHashes"),
    ) ||
    value.version !== 1 ||
    !id(value.id) ||
    !["draft", "frozen"].includes(String(value.state)) ||
    !["unreviewed", "reviewed"].includes(String(value.review)) ||
    !["not-granted", "granted"].includes(String(value.approval)) ||
    value.profile !== "predicate-i32-v1" ||
    !integer(value.repetitions, 1) ||
    value.repetitions > 100 ||
    !nullable(value.model, (v) => str(v) && v.length <= 256) ||
    ![null, "codex-sdk"].includes(value.provider as string | null) ||
    !integer(value.maxCalls, 1) ||
    value.maxCalls > 3 ||
    !nullable(value.maxOutputTokens, (v) => integer(v, 256) && v <= 16384) ||
    !nullable(value.maxTotalTokens, (v) => integer(v, 1) && v <= 10_000_000) ||
    !nullable(value.maxWallMs, (v) => integer(v, 1) && v <= 3_600_000) ||
    !nullable(value.budget, (v) => integer(v, 1)) ||
    !strings(value.unresolved) ||
    !Array.isArray(value.tasks) ||
    !value.tasks.length
  )
    throw new Error("invalid study structure");
  for (const task of value.tasks) {
    if (
      !record(task) ||
      !keys(
        task,
        taskKeys,
        taskKeys.filter((x) => x !== "fixture"),
      ) ||
      !id(task.id) ||
      !str(task.source) ||
      !str(task.metadata) ||
      !str(task.oracle) ||
      (Object.hasOwn(task, "fixture") && !str(task.fixture)) ||
      !strings(task.features) ||
      !str(task.origin) ||
      !["unreviewed", "reviewed"].includes(String(task.review))
    )
      throw new Error("invalid study task");
  }
  if (
    new Set(value.tasks.map((task: StudyTask) => task.id)).size !==
    value.tasks.length
  )
    throw new Error("duplicate study task");
  if (Object.hasOwn(value, "frozenHashes")) {
    if (
      !record(value.frozenHashes) ||
      Object.values(value.frozenHashes).some((v) => !digest(v))
    )
      throw new Error("invalid frozen hashes");
  }
  if (
    value.model !== null &&
    value.maxOutputTokens !== null &&
    value.maxTotalTokens !== null &&
    value.maxWallMs !== null
  ) {
    try {
      parseDevelopmentConfig({
        version: 1,
        mode: "live",
        model: value.model,
        maxCalls: value.maxCalls,
        maxOutputTokens: value.maxOutputTokens,
        maxTotalTokens: value.maxTotalTokens,
        maxWallMs: value.maxWallMs,
        ...(value.provider === "codex-sdk" ? { agent: "codex-sdk" } : {}),
      });
    } catch (error) {
      throw new Error(
        `invalid model configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return value as Study;
}
export function enumerateTrials(study: Study) {
  return study.tasks.flatMap((task) =>
    Array.from({ length: study.repetitions }, (_, i) => ({
      id: `${task.id}-${i + 1}`,
      taskId: task.id,
    })),
  );
}
export function hashesMatch(
  frozen: Record<string, string>,
  current: Record<string, string>,
) {
  const left = Object.keys(frozen).sort();
  const right = Object.keys(current).sort();
  return (
    left.length === right.length &&
    left.every((key, i) => key === right[i] && frozen[key] === current[key])
  );
}
export function parseStudyRun(value: unknown): StudyRun {
  if (
    !record(value) ||
    !(value.version === 1
      ? keys(value, runKeys, runKeys)
      : value.version === 2 &&
        keys(value, runV2Keys, runV2Keys) &&
        digest(value.inputSnapshotHash)) ||
    !str(value.studyPath) ||
    !digest(value.studyHash) ||
    !["fixture", "live"].includes(String(value.mode)) ||
    !["running", "complete", "uncertain"].includes(String(value.status)) ||
    !nullable(value.approvalHash, digest) ||
    !nullable(value.approvalPath, str) ||
    !Array.isArray(value.trials)
  )
    throw new Error("invalid study run");
  for (const trial of value.trials) {
    if (
      !record(trial) ||
      !keys(trial, trialKeys, trialKeys) ||
      !id(trial.id) ||
      !id(trial.taskId) ||
      ![
        "pending",
        "uncertain",
        "pass",
        "fail",
        "unresolved",
        "error",
        "stopped",
      ].includes(String(trial.status)) ||
      !["not-run", "pass", "fail"].includes(String(trial.oracleStatus)) ||
      !digest(trial.sourceHash) ||
      !digest(trial.metadataHash) ||
      !digest(trial.oracleHash) ||
      !nullable(trial.fixtureHash, digest) ||
      !nullable(trial.development, str) ||
      !integer(trial.calls) ||
      !integer(trial.tokens) ||
      !nullable(trial.reason, (v) => typeof v === "string")
    )
      throw new Error("invalid study trial");
  }
  return value as StudyRun;
}
export function matchTrials(
  run: StudyRun,
  study: Study,
  hashes: Record<string, string>,
  allowMissing = false,
) {
  const planned = enumerateTrials(study);
  const expected = new Map(planned.map((trial) => [trial.id, trial]));
  const found = new Map<string, Trial>();
  for (const trial of run.trials) {
    const identity = expected.get(trial.id);
    if (!identity || identity.taskId !== trial.taskId || found.has(trial.id))
      throw new Error("study trial plan mismatch");
    if (
      trial.sourceHash !== hashes[`${trial.taskId}:source`] ||
      trial.metadataHash !== hashes[`${trial.taskId}:metadata`] ||
      trial.oracleHash !== hashes[`${trial.taskId}:oracle`] ||
      (run.mode === "fixture" &&
        trial.fixtureHash !== (hashes[`${trial.taskId}:fixture`] ?? null))
    )
      throw new Error(`trial input hash mismatch: ${trial.id}`);
    if (
      trial.development !== null &&
      trial.development !== `${trial.id}/run.json`
    )
      throw new Error(`invalid trial path: ${trial.id}`);
    if (trial.status !== "pass" && trial.oracleStatus !== "not-run")
      throw new Error(`invalid oracle status: ${trial.id}`);
    if (trial.development === null && trial.oracleStatus !== "not-run")
      throw new Error(`invalid oracle status: ${trial.id}`);
    if (
      trial.development === null &&
      ["pending", "uncertain", "stopped"].includes(trial.status) &&
      (trial.calls !== 0 || trial.tokens !== 0)
    )
      throw new Error(`unrecorded usage: ${trial.id}`);
    found.set(trial.id, trial);
  }
  if (!allowMissing && found.size !== planned.length)
    throw new Error("study trial plan mismatch");
  if (
    !allowMissing &&
    run.status === "complete" &&
    planned.some((trial) =>
      ["pending", "uncertain"].includes(
        found.get(trial.id)?.status ?? "pending",
      ),
    )
  )
    throw new Error("completed study contains unfinished trials");
  if (
    run.status === "uncertain" &&
    !run.trials.some(
      (trial) =>
        trial.status === "uncertain" ||
        (trial.status === "pass" && trial.oracleStatus === "not-run"),
    )
  )
    throw new Error("uncertain study has no uncertain trial");
  return planned.map((trial) => ({
    ...trial,
    saved: found.get(trial.id) ?? null,
  }));
}
