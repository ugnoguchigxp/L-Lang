import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-file";
import { resolveContainedFile } from "./contained-path";
import { runDevelopmentCli } from "./capability-development-cli";
import {
  type DevelopmentRun,
  parseDevelopmentRun,
} from "./capability-development";
import { parseCapabilityMetadata } from "./capability-package";
import { readCapability } from "./capability-package";
import {
  candidatePath,
  createOracleEvidence,
  evaluateCases,
  oracleEvidencePath,
  publishOracleEvidence,
  verifyOracleEvidenceBody,
  verifyOracleEvidenceCheckpoint,
} from "./paper-oracle-evidence";
import { parsePaperOracle } from "./paper-evaluate";
import { contentHash, parsePromptSource, readJson } from "./prompt-source";
import { encodeInput } from "./wasm-contract";
import { instantiateWasmPredicate } from "./wasm-runtime";

import {
  enumerateTrials,
  hashesMatch,
  matchTrials,
  parseStudy,
  parseStudyRun,
  type Study,
  type StudyTask,
  type StudyRun,
  type Trial,
} from "./paper-study-validation";
export { parseStudy } from "./paper-study-validation";
export type { StudyRun } from "./paper-study-validation";

export async function verifyStudyApproval(run: StudyRun) {
  if (run.mode !== "live") return;
  if (!run.approvalPath || !run.approvalHash)
    throw new Error("live approval missing");
  const approval = (await readJson(run.approvalPath)) as Record<
    string,
    unknown
  >;
  if (
    contentHash(approval) !== run.approvalHash ||
    approval.studyHash !== run.studyHash ||
    approval.scope !== "live" ||
    typeof approval.reviewer !== "string" ||
    !approval.reviewer ||
    typeof approval.record !== "string" ||
    !approval.record
  )
    throw new Error("live approval changed since run began");
}
export async function validateStudy(path: string) {
  const study = parseStudy(await readJson(path));
  const root = dirname(resolve(path));
  const diagnostics: string[] = [];
  const reviewPending: string[] = [];
  const hashes: Record<string, string> = {};
  for (const task of study.tasks) {
    try {
      const source = parsePromptSource(
        await readJson(resolve(root, task.source)),
      );
      const metadata = parseCapabilityMetadata(
        await readJson(resolve(root, task.metadata)),
      );
      const oracle = parsePaperOracle(
        await readJson(resolve(root, task.oracle)),
      );
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
      if (task.fixture)
        hashes[`${task.id}:fixture`] = contentHash(
          await readJson(resolve(root, task.fixture)),
        );
    } catch (error) {
      diagnostics.push(
        `${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
async function saveRun(dir: string, run: StudyRun) {
  await atomicWriteFile(
    resolve(dir, "run.json"),
    `${JSON.stringify(run, null, 2)}\n`,
  );
}
async function writeOracleDiagnostic(
  output: string,
  run: StudyRun,
  trial: Trial,
  stage:
    | "prepare"
    | "instantiate"
    | "evaluate"
    | "publish"
    | "readback"
    | "checkpoint",
) {
  const codes = {
    prepare: "ORACLE_PREPARATION_FAILED",
    instantiate: "ORACLE_INSTANTIATION_FAILED",
    evaluate: "ORACLE_EXECUTION_FAILED",
    publish: "ORACLE_PUBLISH_FAILED",
    readback: "ORACLE_READBACK_FAILED",
    checkpoint: "ORACLE_CHECKPOINT_FAILED",
  } as const;
  try {
    await writeFile(
      resolve(output, "oracle-error.json"),
      `${JSON.stringify({ version: 1, format: "llang-paper-oracle-diagnostic", studyHash: run.studyHash, trialId: trial.id, stage, code: codes[stage] }, null, 2)}\n`,
      { flag: "wx" },
    );
  } catch {
    console.error(`Oracle diagnostic write failed at ${stage}`);
    throw new Error("Oracle diagnostic write failed");
  }
}
export async function runStudy(
  studyPath: string,
  mode: "fixture" | "live",
  outDir: string,
  approvalPath?: string,
  hooks: {
    saveRun?: typeof saveRun;
    instantiate?: typeof instantiateWasmPredicate;
    publish?: typeof publishOracleEvidence;
  } = {},
) {
  const validation = await validateStudy(studyPath);
  if (validation.diagnostics.length)
    throw new Error(validation.diagnostics.join("; "));
  const study = parseStudy(await readJson(studyPath));
  let approvalHash: string | null = null;
  if (mode === "live") {
    if (!validation.readyForLive || !approvalPath)
      throw new Error(
        "live study requires reviewed, frozen study and explicit approval",
      );
    const approval = (await readJson(approvalPath)) as {
      studyHash?: string;
      scope?: string;
      reviewer?: string;
      record?: string;
    };
    if (
      approval.studyHash !== validation.studyHash ||
      approval.scope !== "live" ||
      !approval.reviewer ||
      !approval.record
    )
      throw new Error("approval does not match study");
    approvalHash = contentHash(approval);
  }
  const output = resolve(outDir);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const trials: Trial[] = [];
  for (const task of study.tasks)
    for (let i = 0; i < study.repetitions; i++)
      trials.push({
        id: `${task.id}-${i + 1}`,
        taskId: task.id,
        status: "pending",
        oracleStatus: "not-run",
        sourceHash: validation.hashes[`${task.id}:source`] as string,
        metadataHash: validation.hashes[`${task.id}:metadata`] as string,
        oracleHash: validation.hashes[`${task.id}:oracle`] as string,
        fixtureHash:
          mode === "fixture"
            ? (validation.hashes[`${task.id}:fixture`] ?? null)
            : null,
        development: null,
        calls: 0,
        tokens: 0,
        reason: null,
      });
  const run: StudyRun = {
    version: 1,
    studyPath: resolve(studyPath),
    studyHash: validation.studyHash,
    mode,
    trials,
    status: "running",
    approvalHash,
    approvalPath: approvalPath ? resolve(approvalPath) : null,
  };
  await saveRun(output, run);
  return continueStudy(studyPath, output, run, hooks);
}
async function continueStudy(
  studyPath: string,
  dir: string,
  run: StudyRun,
  hooks: {
    saveRun?: typeof saveRun;
    instantiate?: typeof instantiateWasmPredicate;
    publish?: typeof publishOracleEvidence;
  } = {},
) {
  const checkpoint = hooks.saveRun ?? saveRun;
  const study = parseStudy(await readJson(studyPath));
  const root = dirname(resolve(studyPath));
  const current = await validateStudy(studyPath);
  matchTrials(run, study, current.hashes);
  if (
    current.studyHash !== run.studyHash ||
    current.diagnostics.length ||
    run.trials.some(
      (t) =>
        t.sourceHash !== current.hashes[`${t.taskId}:source`] ||
        t.metadataHash !== current.hashes[`${t.taskId}:metadata`] ||
        t.oracleHash !== current.hashes[`${t.taskId}:oracle`],
    )
  )
    throw new Error("study inputs changed since run began");
  if (run.trials.some((t) => t.status === "uncertain")) {
    run.status = "uncertain";
    await checkpoint(dir, run);
    return run;
  }
  for (const trial of run.trials) {
    if (trial.status !== "pending") continue;
    const usedCalls = run.trials.reduce((sum, t) => sum + t.calls, 0);
    if (study.budget !== null && usedCalls + study.maxCalls > study.budget) {
      trial.status = "stopped";
      trial.reason = "study call reservation exceeds budget";
      await checkpoint(dir, run);
      continue;
    }
    const task = study.tasks.find((t) => t.id === trial.taskId) as StudyTask;
    trial.status = "uncertain";
    await checkpoint(dir, run);
    try {
      const output = resolve(dir, trial.id);
      const args = [
        "develop",
        resolve(root, task.source),
        "--metadata",
        resolve(root, task.metadata),
        "--out-dir",
        output,
      ];
      if (run.mode === "fixture") {
        if (!task.fixture) throw new Error("fixture missing");
        args.push("--fixtures", resolve(root, task.fixture));
      } else {
        args.push(
          "--model",
          study.model as string,
          "--max-calls",
          String(study.maxCalls),
          "--max-output-tokens",
          String(study.maxOutputTokens),
          "--max-total-tokens",
          String(study.maxTotalTokens),
          "--max-wall-ms",
          String(study.maxWallMs),
        );
        if (study.provider === "codex-sdk") args.push("--agent", "codex-sdk");
      }
      const response = await runDevelopmentCli(args);
      const development = response.result as DevelopmentRun;
      if (development.status === "pass") {
        const raw = await readJson(resolve(output, "run.json"));
        const saved = parseDevelopmentRun(raw);
        const last = saved.attempts.at(-1);
        if (
          !saved.complete ||
          saved.status !== "pass" ||
          !last ||
          last.status !== "pass" ||
          saved.sourceHash !== trial.sourceHash ||
          saved.metadataHash !== trial.metadataHash ||
          contentHash(saved) !== contentHash(development) ||
          saved.logicalCalls !== development.logicalCalls ||
          saved.usedTokens !== development.usedTokens ||
          saved.stopReason !== development.stopReason ||
          saved.attempts.length !== development.attempts.length ||
          last.packageHash !== development.attempts.at(-1)?.packageHash
        )
          throw new Error("development record mismatch");
      }
      trial.status =
        development.status === "running" ? "error" : development.status;
      trial.development = `${trial.id}/run.json`;
      trial.calls = development.logicalCalls;
      trial.tokens = development.usedTokens;
      trial.reason = development.stopReason;
      if (development.status === "pass") {
        run.status = "uncertain";
        try {
          await checkpoint(dir, run);
        } catch {
          await writeOracleDiagnostic(output, run, trial, "checkpoint");
          throw new Error("Oracle checkpoint failed");
        }
        let stage:
          | "prepare"
          | "instantiate"
          | "evaluate"
          | "publish"
          | "readback"
          | "checkpoint" = "prepare";
        try {
          const developmentRaw = await readJson(resolve(output, "run.json"));
          const saved = parseDevelopmentRun(developmentRaw);
          const last = saved.attempts.at(-1);
          if (
            !saved.complete ||
            saved.status !== "pass" ||
            !last ||
            last.status !== "pass" ||
            saved.sourceHash !== trial.sourceHash ||
            saved.metadataHash !== trial.metadataHash ||
            last.index < 0
          )
            throw new Error("invalid saved development");
          const pkg = await readCapability(
            await resolveContainedFile(
              dir,
              candidatePath(trial.id, last.index),
              "trial candidate",
              { rejectSymbolicLinks: true },
            ),
          );
          if (
            pkg.source.id !== trial.taskId ||
            contentHash(pkg.source) !== trial.sourceHash ||
            contentHash(pkg.manifest.metadata) !== trial.metadataHash ||
            pkg.packageHash !== last.packageHash ||
            pkg.lock.irHash !== last.irHash
          )
            throw new Error("candidate linkage mismatch");
          const oracle = parsePaperOracle(
            await readJson(resolve(root, task.oracle)),
          );
          if (
            oracle.taskId !== trial.taskId ||
            contentHash(oracle) !== trial.oracleHash
          )
            throw new Error("Oracle linkage mismatch");
          stage = "instantiate";
          const runtime = await (hooks.instantiate ?? instantiateWasmPredicate)(
            pkg.build,
            pkg.bytes,
          );
          stage = "evaluate";
          const cases = evaluateCases(oracle, runtime.evaluate);
          const evidence = createOracleEvidence(
            run,
            trial,
            developmentRaw,
            saved,
            pkg,
            oracle,
            cases,
          );
          stage = "publish";
          await (hooks.publish ?? publishOracleEvidence)(
            resolve(dir, oracleEvidencePath(trial.id)),
            evidence,
          );
          stage = "readback";
          const sidecarRaw = await readJson(
            await resolveContainedFile(
              dir,
              oracleEvidencePath(trial.id),
              "Oracle evidence",
              { rejectSymbolicLinks: true },
            ),
          );
          const verified = await verifyOracleEvidenceBody(
            dir,
            run,
            trial,
            sidecarRaw,
            developmentRaw,
            saved,
            oracle,
          );
          stage = "checkpoint";
          if (verified.result === "error") {
            await writeOracleDiagnostic(output, run, trial, "evaluate");
            return run;
          }
          trial.oracleStatus = verified.result;
          run.status = "running";
          await checkpoint(dir, run);
          verifyOracleEvidenceCheckpoint(run, trial, verified);
        } catch {
          trial.oracleStatus = "not-run";
          run.status = "uncertain";
          await writeOracleDiagnostic(output, run, trial, stage);
          return run;
        }
      }
    } catch (error) {
      if (trial.status === "pass") {
        run.status = "uncertain";
        return run;
      }
      trial.status = "uncertain";
      trial.reason = error instanceof Error ? error.message : String(error);
    }
    await checkpoint(dir, run);
    if (trial.status === "uncertain") {
      run.status = "uncertain";
      await checkpoint(dir, run);
      return run;
    }
  }
  run.status = "complete";
  await checkpoint(dir, run);
  return run;
}
export async function resumeStudy(runDir: string) {
  const run = parseStudyRun(await readJson(resolve(runDir, "run.json")));
  const validation = await validateStudy(run.studyPath);
  const study = parseStudy(await readJson(run.studyPath));
  matchTrials(run, study, validation.hashes);
  if (
    run.status === "uncertain" ||
    run.trials.some((t) => t.status === "uncertain")
  )
    throw new Error(
      "uncertain trial requires human decision; no automatic resend",
    );
  await verifyTrialRecords(runDir, run, study);
  if (validation.studyHash !== run.studyHash || validation.diagnostics.length)
    throw new Error("study changed since run began");
  if (run.mode === "live") {
    await verifyStudyApproval(run);
  }
  return continueStudy(run.studyPath, resolve(runDir), run);
}
async function verifyTrialRecords(runDir: string, run: StudyRun, study: Study) {
  for (const trial of run.trials) {
    let sidecarExists = false;
    try {
      await lstat(resolve(runDir, oracleEvidencePath(trial.id)));
      sidecarExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (sidecarExists && trial.status !== "pass")
      throw new Error(`Oracle sidecar state mismatch: ${trial.id}`);
    if (!trial.development) {
      if (sidecarExists)
        throw new Error(`Oracle sidecar development missing: ${trial.id}`);
      if (["pass", "fail", "unresolved", "error"].includes(trial.status))
        throw new Error(`development evidence missing: ${trial.id}`);
      continue;
    }
    const path = await resolveContainedFile(
      runDir,
      trial.development,
      "trial record",
      { rejectSymbolicLinks: true },
    );
    const developmentRaw = await readJson(path);
    const development = parseDevelopmentRun(developmentRaw);
    if (
      development.sourceHash !== trial.sourceHash ||
      development.metadataHash !== trial.metadataHash ||
      (trial.status !== "uncertain" && development.status !== trial.status) ||
      development.logicalCalls !== trial.calls ||
      development.usedTokens !== trial.tokens ||
      (trial.status !== "uncertain" && development.stopReason !== trial.reason)
    )
      throw new Error(`trial linkage mismatch: ${trial.id}`);
    if (trial.oracleStatus !== "not-run") {
      if (development.status !== "pass")
        throw new Error(`invalid Oracle linkage: ${trial.id}`);
      const last = development.attempts.length - 1;
      const relativeCandidate = `${trial.id}/attempt-${last}/candidate/capability.json`;
      const candidate = await readCapability(
        await resolveContainedFile(
          runDir,
          relativeCandidate,
          "trial candidate",
          { rejectSymbolicLinks: true },
        ),
      );
      if (
        candidate.source.id !== trial.taskId ||
        contentHash(candidate.source) !== trial.sourceHash ||
        contentHash(candidate.manifest.metadata) !== trial.metadataHash ||
        candidate.packageHash !== development.attempts[last]?.packageHash ||
        candidate.lock.irHash !== development.attempts[last]?.irHash
      )
        throw new Error(`candidate linkage mismatch: ${trial.id}`);
    }
    if (sidecarExists) {
      const raw = await readJson(
        await resolveContainedFile(
          runDir,
          oracleEvidencePath(trial.id),
          "Oracle evidence",
          { rejectSymbolicLinks: true },
        ),
      );
      const task = study.tasks.find((t) => t.id === trial.taskId)!;
      const oracle = parsePaperOracle(
        await readJson(resolve(dirname(run.studyPath), task.oracle)),
      );
      const evidence = await verifyOracleEvidenceBody(
        runDir,
        run,
        trial,
        raw,
        developmentRaw,
        development,
        oracle,
      );
      verifyOracleEvidenceCheckpoint(run, trial, evidence);
    }
  }
}
export async function saveStudyValidation(path: string, outDir: string) {
  const result = await validateStudy(path);
  await mkdir(dirname(resolve(outDir)), { recursive: true });
  await mkdir(resolve(outDir));
  await writeFile(
    resolve(outDir, "study-validation.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  return result;
}
export async function saveStudyReview(path: string, outDir: string) {
  const study = parseStudy(await readJson(path));
  const validation = await validateStudy(path);
  const root = dirname(resolve(path));
  const tasks = [];
  for (const task of study.tasks) {
    const source = parsePromptSource(
      await readJson(resolve(root, task.source)),
    );
    const oracle = parsePaperOracle(await readJson(resolve(root, task.oracle)));
    tasks.push({
      id: task.id,
      origin: task.origin,
      review: task.review,
      features: task.features,
      requirements: source.requirements,
      contract: source.contract,
      unresolvedWhen: source.unresolvedWhen,
      oracle: {
        review: oracle.review,
        origin: oracle.origin,
        cases: oracle.cases,
      },
      hashes: {
        source: validation.hashes[`${task.id}:source`],
        metadata: validation.hashes[`${task.id}:metadata`],
        oracle: validation.hashes[`${task.id}:oracle`],
        fixture: validation.hashes[`${task.id}:fixture`] ?? null,
      },
    });
  }
  const result = {
    version: 1,
    studyId: study.id,
    studyHash: validation.studyHash,
    state: study.state,
    review: study.review,
    approval: study.approval,
    model: study.model,
    provider: study.provider,
    maxCalls: study.maxCalls,
    maxOutputTokens: study.maxOutputTokens,
    maxTotalTokens: study.maxTotalTokens,
    maxWallMs: study.maxWallMs,
    budget: study.budget,
    unresolved: study.unresolved,
    tasks,
    diagnostics: validation.diagnostics,
    missingConditions: validation.missingConditions,
    readyForLive: validation.readyForLive,
  };
  const cell = (value: unknown) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("|", "\\|")
      .replaceAll("\r", "<br>")
      .replaceAll("\n", "<br>");
  const md = [
    `# Study review: ${cell(study.id)}`,
    "",
    `Study hash: ${validation.studyHash}`,
    `Ready for live: ${validation.readyForLive}`,
    `Model: ${cell(study.model)}; provider: ${cell(study.provider)}; max calls: ${study.maxCalls}; output tokens: ${cell(study.maxOutputTokens)}; total tokens: ${cell(study.maxTotalTokens)}; wall ms: ${cell(study.maxWallMs)}; call budget: ${cell(study.budget)}`,
    "",
    "This document prepares review. It does not grant review or approval.",
    "Existing-example tasks are not unknown or held-out tasks.",
    "",
    "## Missing conditions",
    "",
    ...validation.missingConditions.map((x) => `- ${cell(x)}`),
    "",
    "## Diagnostics",
    "",
    ...validation.diagnostics.map((x) => `- ${cell(x)}`),
    "",
    ...tasks.flatMap((task) => [
      `## ${cell(task.id)}`,
      "",
      `Origin: ${cell(task.origin)}; task review: ${cell(task.review)}; Oracle review: ${cell(task.oracle.review)}`,
      `Features: ${cell(task.features.join(", "))}`,
      "",
      "| Requirement | Text |",
      "| --- | --- |",
      ...task.requirements.map((r) => `| ${cell(r.id)} | ${cell(r.text)} |`),
      "",
      `Input contract: ${cell(JSON.stringify(task.contract))}`,
      "",
      `Unresolved expectations: ${cell(task.unresolvedWhen.join("; "))}`,
      "",
      `Hashes: ${cell(JSON.stringify(task.hashes))}`,
      "",
      `Oracle cases: ${task.oracle.cases.length}`,
      "",
      "| Oracle case | Input | Expected |",
      "| --- | --- | --- |",
      ...task.oracle.cases.map(
        (c) =>
          `| ${cell(c.id)} | ${cell(JSON.stringify(c.input))} | ${cell(JSON.stringify(c.expected))} |`,
      ),
      "",
      "Review: requirements and expected values [ ]; expressibility [ ]; unresolved expectations [ ]; input boundaries [ ]; overlap with existing tasks [ ].",
      "",
    ]),
  ].join("\n");
  const output = resolve(outDir);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await writeFile(
    resolve(output, "review.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(resolve(output, "review.md"), `${md}\n`, { flag: "wx" });
  return result;
}
