import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseCapabilityMetadata } from "./capability-package";
import { resolveContainedFile } from "./contained-path";
import { parsePaperOracle } from "./paper-evaluate";
import {
  type Study,
  type StudyRun,
  hashesMatch,
  matchTrials,
  parseStudy,
} from "./paper-study-validation";
import { contentHash, parsePromptSource, readJson } from "./prompt-source";
import { encodeInput } from "./wasm-contract";

type Source = ReturnType<typeof parsePromptSource>;
type Metadata = ReturnType<typeof parseCapabilityMetadata>;
type Oracle = ReturnType<typeof parsePaperOracle>;
export type InputTask = {
  taskId: string;
  source: Source;
  metadata: Metadata;
  oracle: Oracle;
  fixture: unknown | null;
};
export type LoadedTask = {
  taskId: string;
  value: InputTask | null;
  error: string | null;
};
export type LoadedStudyInputs = { study: Study; tasks: LoadedTask[] };
export type InputSnapshot = {
  version: 1;
  format: "llang-paper-study-inputs";
  study: Study;
  studyHash: string;
  tasks: InputTask[];
  approval: Record<string, unknown> | null;
  approvalHash: string | null;
  checksum: string;
};
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
const hash = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function parseStudyApproval(
  value: unknown,
  studyHash: string,
): Record<string, unknown> {
  if (
    !object(value) ||
    value.studyHash !== studyHash ||
    value.scope !== "live" ||
    typeof value.reviewer !== "string" ||
    !value.reviewer.trim() ||
    typeof value.record !== "string" ||
    !value.record.trim()
  )
    throw new Error("approval does not match study");
  return value;
}
export async function loadStudyInputs(
  path: string,
): Promise<LoadedStudyInputs> {
  const study = parseStudy(await readJson(path));
  const root = dirname(resolve(path));
  const cache = new Map<string, Promise<unknown>>();
  const read = (relative: string) => {
    const absolute = resolve(root, relative);
    let found = cache.get(absolute);
    if (!found) {
      found = readJson(absolute);
      cache.set(absolute, found);
    }
    return found;
  };
  const tasks: LoadedTask[] = [];
  for (const task of study.tasks) {
    try {
      const source = parsePromptSource(await read(task.source));
      const metadata = parseCapabilityMetadata(await read(task.metadata));
      const oracle = parsePaperOracle(await read(task.oracle));
      const fixture = task.fixture ? await read(task.fixture) : null;
      tasks.push({
        taskId: task.id,
        value: { taskId: task.id, source, metadata, oracle, fixture },
        error: null,
      });
    } catch (error) {
      tasks.push({ taskId: task.id, value: null, error: message(error) });
    }
  }
  return { study, tasks };
}
export function validateLoadedStudy(loaded: LoadedStudyInputs) {
  const { study } = loaded;
  const diagnostics: string[] = [];
  const reviewPending: string[] = [];
  const hashes: Record<string, string> = {};
  for (const task of study.tasks) {
    const item = loaded.tasks.find((x) => x.taskId === task.id);
    if (!item?.value) {
      diagnostics.push(`${task.id}: ${item?.error ?? "input missing"}`);
      continue;
    }
    const { source, metadata, oracle, fixture } = item.value;
    try {
      if (oracle.review !== "reviewed")
        reviewPending.push(`${task.id}: Oracle review incomplete`);
      if (
        source.id !== task.id ||
        metadata.id !== task.id ||
        oracle.taskId !== task.id
      )
        diagnostics.push(`${task.id}: identity mismatch`);
      if (source.profile !== study.profile)
        diagnostics.push(`${task.id}: unknown profile`);
      for (const c of oracle.cases) {
        let valid = true;
        try {
          encodeInput(source.contract, c.input);
        } catch {
          valid = false;
        }
        if (valid !== (c.expected.kind === "value"))
          diagnostics.push(
            `${task.id}/${c.id}: expected input validity mismatch`,
          );
      }
      if (task.source === task.oracle || task.metadata === task.oracle)
        diagnostics.push(`${task.id}: Oracle mixed with model-visible input`);
      hashes[`${task.id}:source`] = contentHash(source);
      hashes[`${task.id}:metadata`] = contentHash(metadata);
      hashes[`${task.id}:oracle`] = contentHash(oracle);
      if (task.fixture) hashes[`${task.id}:fixture`] = contentHash(fixture);
    } catch (error) {
      diagnostics.push(`${task.id}: ${message(error)}`);
    }
  }
  if (study.frozenHashes && !hashesMatch(study.frozenHashes, hashes))
    diagnostics.push("review invalidated by changed inputs");
  if (
    study.budget !== null &&
    (!Number.isSafeInteger(study.budget) || study.budget <= 0)
  )
    diagnostics.push("invalid study call budget");
  const missingConditions = [...study.unresolved, ...reviewPending];
  if (study.state !== "frozen")
    missingConditions.push("study state is not frozen");
  for (const key of [
    "model",
    "provider",
    "maxOutputTokens",
    "maxTotalTokens",
    "maxWallMs",
    "budget",
  ] as const)
    if (study[key] === null) missingConditions.push(`${key} is unset`);
  if (
    study.review !== "reviewed" ||
    study.tasks.some((t) => t.review !== "reviewed")
  )
    missingConditions.push("independent task review incomplete");
  if (study.approval !== "granted")
    missingConditions.push("live approval absent");
  if (!study.frozenHashes) missingConditions.push("input hashes not frozen");
  return {
    version: 1,
    studyId: study.id,
    studyHash: contentHash(study),
    hashes,
    diagnostics,
    missingConditions,
    readyForLive: !diagnostics.length && !missingConditions.length,
  };
}
export function executableInputs(loaded: LoadedStudyInputs): InputTask[] {
  const validation = validateLoadedStudy(loaded);
  if (validation.diagnostics.length)
    throw new Error(validation.diagnostics.join("; "));
  return loaded.tasks.map((t) => {
    if (!t.value) throw new Error(`study input missing: ${t.taskId}`);
    return t.value;
  });
}
export function createInputSnapshot(
  loaded: LoadedStudyInputs,
  approval: Record<string, unknown> | null,
): InputSnapshot {
  const tasks = executableInputs(loaded);
  const studyHash = contentHash(loaded.study);
  if (approval) parseStudyApproval(approval, studyHash);
  const unsigned = {
    version: 1 as const,
    format: "llang-paper-study-inputs" as const,
    study: loaded.study,
    studyHash,
    tasks,
    approval,
    approvalHash: approval ? contentHash(approval) : null,
  };
  return { ...unsigned, checksum: contentHash(unsigned) };
}
export function parseInputSnapshot(value: unknown): InputSnapshot {
  if (
    !object(value) ||
    !exact(value, [
      "version",
      "format",
      "study",
      "studyHash",
      "tasks",
      "approval",
      "approvalHash",
      "checksum",
    ])
  )
    throw new Error("invalid study input snapshot fields");
  const { checksum, ...unsigned } = value;
  if (
    value.version !== 1 ||
    value.format !== "llang-paper-study-inputs" ||
    !hash(checksum) ||
    checksum !== contentHash(unsigned) ||
    !hash(value.studyHash)
  )
    throw new Error("invalid study input snapshot header");
  const study = parseStudy(value.study);
  if (
    value.studyHash !== contentHash(study) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length !== study.tasks.length
  )
    throw new Error("study input snapshot plan mismatch");
  const tasks: InputTask[] = [];
  for (let i = 0; i < study.tasks.length; i++) {
    const planned = study.tasks[i];
    const raw = value.tasks[i];
    if (
      !planned ||
      !object(raw) ||
      !exact(raw, ["taskId", "source", "metadata", "oracle", "fixture"]) ||
      raw.taskId !== planned.id ||
      (planned.fixture ? raw.fixture === null : raw.fixture !== null)
    )
      throw new Error("study input snapshot task mismatch");
    const source = parsePromptSource(raw.source);
    const metadata = parseCapabilityMetadata(raw.metadata);
    const oracle = parsePaperOracle(raw.oracle);
    if (
      contentHash(source) !== contentHash(raw.source) ||
      contentHash(metadata) !== contentHash(raw.metadata) ||
      contentHash(oracle) !== contentHash(raw.oracle)
    )
      throw new Error("study input snapshot changed by parsing");
    tasks.push({
      taskId: planned.id,
      source,
      metadata,
      oracle,
      fixture: raw.fixture,
    });
  }
  if (value.approval === null) {
    if (value.approvalHash !== null)
      throw new Error("invalid snapshot approval hash");
  } else if (
    !hash(value.approvalHash) ||
    contentHash(parseStudyApproval(value.approval, value.studyHash)) !==
      value.approvalHash
  )
    throw new Error("invalid snapshot approval");
  const validation = validateLoadedStudy({
    study,
    tasks: tasks.map((t) => ({ taskId: t.taskId, value: t, error: null })),
  });
  if (validation.diagnostics.length)
    throw new Error(validation.diagnostics.join("; "));
  return value as InputSnapshot;
}
export function verifyInputSnapshotRun(
  snapshot: InputSnapshot,
  run: Extract<StudyRun, { version: 2 }>,
  allowMissing = false,
) {
  const validation = validateLoadedStudy({
    study: snapshot.study,
    tasks: snapshot.tasks.map((t) => ({
      taskId: t.taskId,
      value: t,
      error: null,
    })),
  });
  if (
    run.inputSnapshotHash !== contentHash(snapshot) ||
    run.studyHash !== snapshot.studyHash ||
    validation.diagnostics.length ||
    (run.mode === "live" &&
      run.trials.some((trial) => trial.fixtureHash !== null)) ||
    (run.mode === "fixture"
      ? snapshot.approval !== null ||
        snapshot.approvalHash !== null ||
        run.approvalHash !== null ||
        run.approvalPath !== null
      : !snapshot.approval ||
        snapshot.approvalHash !== run.approvalHash ||
        !run.approvalPath ||
        !validation.readyForLive)
  )
    throw new Error("study input snapshot/run mismatch");
  return {
    validation,
    planned: matchTrials(run, snapshot.study, validation.hashes, allowMissing),
  };
}
export async function readInputSnapshot(
  runDir: string,
): Promise<InputSnapshot> {
  return parseInputSnapshot(
    await readJson(
      await resolveContainedFile(
        runDir,
        "inputs.json",
        "study input snapshot",
        { rejectSymbolicLinks: true },
      ),
    ),
  );
}
export async function publishInputSnapshot(
  path: string,
  snapshot: InputSnapshot,
  operations = { link, unlink },
) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  let failed = false;
  let failure: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`);
    await handle.sync();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) {
    await operations.unlink(temp);
    throw failure;
  }
  try {
    await operations.link(temp, path);
  } finally {
    await operations.unlink(temp);
  }
}
