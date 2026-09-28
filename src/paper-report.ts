import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseDevelopmentRun } from "./capability-development";
import { readCapability } from "./capability-package";
import { resolveContainedFile } from "./contained-path";
import { contentHash, readJson } from "./prompt-source";
import {
  oracleEvidencePath,
  parseOracleEvidence,
  verifyOracleEvidenceBody,
  verifyOracleEvidenceCheckpoint,
} from "./paper-oracle-evidence";
import { parsePaperOracle } from "./paper-evaluate";
import {
  readInputSnapshot,
  verifyInputSnapshotRun,
} from "./paper-study-inputs";
import { validateStudy } from "./paper-study";
import {
  enumerateTrials,
  matchTrials,
  parseStudy,
  parseStudyRun,
} from "./paper-study-validation";

type ReportRow = {
  taskId: string;
  trialId: string;
  status: string;
  firstPass: boolean;
  repairedPass: boolean;
  suitePass: boolean;
  oracleStatus: string;
  oraclePass: boolean | null;
  oracleUnverified: boolean;
  oracleEvidencePath: string | null;
  oracleEvidenceHash: string | null;
  oracleExecutionError: boolean;
  calls: number | null;
  tokens: number | null;
  inputHash: string;
  evidence: string;
  reason: string;
};
const csvCell = (value: unknown) => {
  const raw = String(value ?? "");
  const safe = /^\s*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};
async function rejectSymbolicLinkAncestors(root: string, segments: string[]) {
  for (let count = 1; count <= segments.length; count++) {
    try {
      if (
        (
          await lstat(resolve(root, ...segments.slice(0, count)))
        ).isSymbolicLink()
      )
        throw new Error("trial evidence must not use a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export async function buildPaperReport(runDir: string) {
  const run = parseStudyRun(await readJson(resolve(runDir, "run.json")));
  const snapshot = run.version === 2 ? await readInputSnapshot(runDir) : null;
  const verified =
    run.version === 2 && snapshot
      ? verifyInputSnapshotRun(snapshot, run, true)
      : null;
  const validation =
    verified?.validation ?? (await validateStudy(run.studyPath));
  if (validation.studyHash !== run.studyHash || validation.diagnostics.length)
    throw new Error("study input changed since run");
  const study = snapshot?.study ?? parseStudy(await readJson(run.studyPath));
  const planned =
    verified?.planned ?? matchTrials(run, study, validation.hashes, true);
  const reasons = new Set<string>(["study-evidence-verifier-pending"]);
  if (run.mode === "fixture") reasons.add("fixture-only");
  if (!validation.readyForLive) reasons.add("study-not-ready");
  if (planned.some((entry) => !entry.saved)) reasons.add("missing-trials");
  if (run.status === "uncertain") reasons.add("run-uncertain");
  if (
    planned.some(
      (entry) =>
        !entry.saved || ["pending", "uncertain"].includes(entry.saved.status),
    )
  )
    reasons.add("unfinished-trials");
  if (
    run.status === "complete" &&
    planned.some(
      (entry) =>
        !entry.saved || ["pending", "uncertain"].includes(entry.saved.status),
    )
  )
    reasons.add("run-status-inconsistent");
  if (run.mode === "live" && run.version === 1) {
    if (!run.approvalPath || !run.approvalHash)
      reasons.add("approval-unavailable");
    else {
      try {
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
          reasons.add("approval-mismatch");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          reasons.add("approval-unavailable");
        else reasons.add("approval-mismatch");
      }
    }
  }
  const rows: ReportRow[] = [];
  let incompleteEvidenceTrials = 0;
  for (const entry of planned) {
    const t = entry.saved;
    const sidecarPath = oracleEvidencePath(entry.id);
    let sidecarRaw: unknown = null;
    let sidecar: ReturnType<typeof parseOracleEvidence> | null = null;
    let oracleEvidenceHash: string | null = null;
    let oraclePass: boolean | null = null;
    let oracleExecutionError = false;
    let oracleUnverified = false;
    let developmentRaw: unknown = null;
    let oracle: ReturnType<typeof parsePaperOracle> | null = null;
    const sidecarFile = resolve(runDir, sidecarPath);
    let sidecarExists = false;
    try {
      await lstat(sidecarFile);
      sidecarExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (sidecarExists) {
      sidecarRaw = await readJson(
        await resolveContainedFile(runDir, sidecarPath, "Oracle evidence", {
          rejectSymbolicLinks: true,
        }),
      );
      sidecar = parseOracleEvidence(sidecarRaw);
      if (t?.status !== "pass")
        throw new Error(`Oracle sidecar state mismatch: ${entry.id}`);
      const task = study.tasks.find((x) => x.id === entry.taskId);
      if (!task) throw new Error(`Oracle task missing: ${entry.taskId}`);
      oracle = snapshot
        ? (snapshot.tasks.find((x) => x.taskId === entry.taskId)?.oracle ??
          (() => {
            throw new Error("snapshot Oracle missing");
          })())
        : parsePaperOracle(
            await readJson(resolve(dirname(run.studyPath), task.oracle)),
          );
      if (
        sidecar.studyHash !== run.studyHash ||
        sidecar.trialId !== t.id ||
        sidecar.taskId !== t.taskId ||
        sidecar.oracleHash !== t.oracleHash ||
        sidecar.oracleHash !== contentHash(oracle)
      )
        throw new Error(`Oracle sidecar identity mismatch: ${entry.id}`);
      verifyOracleEvidenceCheckpoint(run, t, sidecar);
    }
    let development: ReturnType<typeof parseDevelopmentRun> | null = null;
    let candidatePresent = false;
    if (t?.development) {
      await rejectSymbolicLinkAncestors(runDir, [t.id]);
      const lexical = resolve(runDir, t.development);
      let exists = false;
      try {
        await lstat(lexical);
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (exists) {
        developmentRaw = await readJson(
          await resolveContainedFile(runDir, t.development, "trial record", {
            rejectSymbolicLinks: true,
          }),
        );
        development = parseDevelopmentRun(developmentRaw);
        if (
          development.sourceHash !== t.sourceHash ||
          development.metadataHash !== t.metadataHash ||
          (t.status !== "uncertain" && development.status !== t.status) ||
          development.logicalCalls !== t.calls ||
          development.usedTokens !== t.tokens ||
          (t.status !== "uncertain" && development.stopReason !== t.reason)
        )
          throw new Error(`trial linkage mismatch: ${t.id}`);
      }
    }
    if (t?.status === "pass" && development) {
      const last = development.attempts.length - 1;
      await rejectSymbolicLinkAncestors(runDir, [
        t.id,
        `attempt-${last}`,
        "candidate",
      ]);
      const relativeCandidate = `${t.id}/attempt-${last}/candidate/capability.json`;
      const candidate = resolve(
        runDir,
        t.id,
        `attempt-${last}`,
        "candidate",
        "capability.json",
      );
      try {
        await lstat(candidate);
        candidatePresent = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (candidatePresent) {
        const pkg = await readCapability(
          await resolveContainedFile(
            runDir,
            relativeCandidate,
            "trial candidate",
            { rejectSymbolicLinks: true },
          ),
        );
        if (
          pkg.source.id !== t.taskId ||
          contentHash(pkg.source) !== t.sourceHash ||
          contentHash(pkg.manifest.metadata) !== t.metadataHash ||
          pkg.packageHash !== development.attempts[last]?.packageHash ||
          pkg.lock.irHash !== development.attempts[last]?.irHash
        )
          throw new Error(`candidate linkage mismatch: ${t.id}`);
      }
    }
    if (sidecar) {
      if (!t || !oracle)
        throw new Error(`Oracle sidecar state mismatch: ${entry.id}`);
      if (!development || !candidatePresent) {
        reasons.add("oracle-evidence-incomplete");
        oracleUnverified = true;
      } else {
        const verified = await verifyOracleEvidenceBody(
          runDir,
          run,
          t,
          sidecarRaw,
          developmentRaw,
          development,
          oracle,
        );
        verifyOracleEvidenceCheckpoint(run, t, verified);
        oracleEvidenceHash = contentHash(sidecarRaw);
        oraclePass =
          verified.result === "pass"
            ? true
            : verified.result === "fail"
              ? false
              : null;
        oracleExecutionError = verified.result === "error";
        if (oracleExecutionError) reasons.add("oracle-execution-error");
      }
    } else if (t && t.oracleStatus !== "not-run") {
      oracleUnverified = true;
      reasons.add("oracle-evidence-not-recorded");
      if (!development || !candidatePresent)
        reasons.add("oracle-evidence-incomplete");
    }
    if (
      t &&
      (!development || (t.status === "pass" && !candidatePresent)) &&
      ["pass", "fail", "unresolved", "error"].includes(t.status)
    )
      incompleteEvidenceTrials++;
    rows.push({
      taskId: entry.taskId,
      trialId: entry.id,
      status: t?.status ?? "missing",
      firstPass:
        t?.status === "pass" &&
        candidatePresent &&
        development?.attempts[0]?.status === "pass",
      repairedPass:
        t?.status === "pass" &&
        candidatePresent &&
        development !== null &&
        development.attempts[0]?.status !== "pass",
      suitePass: t?.status === "pass" && candidatePresent,
      oracleStatus: t?.oracleStatus ?? "missing",
      oraclePass,
      oracleUnverified,
      oracleEvidencePath: oracleEvidenceHash ? sidecarPath : null,
      oracleEvidenceHash,
      oracleExecutionError,
      calls: development?.logicalCalls ?? null,
      tokens: development?.usedTokens ?? null,
      inputHash:
        t?.sourceHash ?? validation.hashes[`${entry.taskId}:source`] ?? "",
      evidence: development ? (t?.development ?? "") : "",
      reason: t?.reason ?? "",
    });
  }
  if (incompleteEvidenceTrials) reasons.add("development-evidence-missing");
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const completed = rows.filter(
    (row) => !["pending", "uncertain", "missing"].includes(row.status),
  ).length;
  const recordIntegrity =
    !incompleteEvidenceTrials &&
    !reasons.has("oracle-evidence-incomplete") &&
    run.status !== "uncertain" &&
    !reasons.has("missing-trials") &&
    !reasons.has("unfinished-trials") &&
    !reasons.has("run-status-inconsistent")
      ? "verified"
      : "incomplete";
  return {
    version: 2,
    mode: run.mode,
    evidenceEligible: false,
    eligibilityReasons: [...reasons].sort(),
    recordIntegrity,
    studyHash: run.studyHash,
    tasks: study.tasks.length,
    plannedTrials: enumerateTrials(study).length,
    recordedTrialCount: run.trials.length,
    completedTrials: completed,
    missingTrials: rows.length - completed,
    incompleteEvidenceTrials,
    counts,
    firstPass: rows.filter((row) => row.firstPass).length,
    repairedPass: rows.filter((row) => row.repairedPass).length,
    suitePass: rows.filter((row) => row.suitePass).length,
    oraclePass: rows.filter((row) => row.oraclePass === true).length,
    oracleFail: rows.filter((row) => row.oraclePass === false).length,
    oracleExecutionError: rows.filter((row) => row.oracleExecutionError).length,
    oracleNotRun: rows.filter((row) =>
      ["not-run", "missing"].includes(row.oracleStatus),
    ).length,
    oracleUnverified: rows.filter((row) => row.oracleUnverified).length,
    rows,
  };
}
export async function savePaperReport(runDir: string, outDir: string) {
  if (await Bun.file(resolve(runDir, "reproduction.json")).exists())
    return saveAccessReport(runDir, outDir);
  const report = await buildPaperReport(runDir);
  const output = resolve(outDir);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const fields: (keyof ReportRow)[] = [
    "taskId",
    "trialId",
    "status",
    "firstPass",
    "repairedPass",
    "suitePass",
    "oraclePass",
    "calls",
    "tokens",
    "inputHash",
    "evidence",
    "reason",
    "oracleStatus",
    "oracleUnverified",
    "oracleEvidencePath",
    "oracleEvidenceHash",
    "oracleExecutionError",
  ];
  const csv = `${[
    fields.map(csvCell).join(","),
    ...report.rows.map((r) => fields.map((key) => csvCell(r[key])).join(",")),
  ].join("\n")}\n`;
  const md = [
    `# ${report.mode === "fixture" ? "Fixture only — not research results" : "Study results"}`,
    "",
    `Study: ${report.studyHash}`,
    `Tasks: ${report.tasks}; planned trials: ${report.plannedTrials}; recorded: ${report.recordedTrialCount}; completed: ${report.completedTrials}; missing: ${report.missingTrials}; incomplete evidence: ${report.incompleteEvidenceTrials}`,
    `Record integrity: ${report.recordIntegrity}; evidence eligible: ${report.evidenceEligible}`,
    `Eligibility reasons: ${report.eligibilityReasons.join(", ")}`,
    `First pass: ${report.firstPass}; repaired pass: ${report.repairedPass}; suite pass: ${report.suitePass}; verified Oracle pass: ${report.oraclePass}; verified Oracle fail: ${report.oracleFail}; Oracle execution error: ${report.oracleExecutionError}; Oracle not run: ${report.oracleNotRun}; Oracle unverified: ${report.oracleUnverified}`,
    "Completed trials counts terminal development outcomes; Oracle counts are separate and may overlap not-run after execution errors.",
    "",
    "| Task | Trial | Status | Suite | Oracle | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.rows.map(
      (r) =>
        `| ${r.taskId} | ${r.trialId} | ${r.status} | ${r.suitePass} | ${r.oracleUnverified ? "unverified" : r.oracleExecutionError ? "execution-error" : (r.oraclePass ?? "not-run")} | ${(r.oracleEvidencePath ?? r.evidence) || "missing"} |`,
    ),
    "",
  ].join("\n");
  await writeFile(
    resolve(output, "summary.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(resolve(output, "table.csv"), csv, { flag: "wx" });
  await writeFile(resolve(output, "table.md"), md, { flag: "wx" });
  return {
    summary: report,
    hashes: { csv: contentHash(csv), markdown: contentHash(md) },
  };
}

async function saveAccessReport(runDir: string, outDir: string) {
  const reproduction = (await readJson(
    resolve(runDir, "reproduction.json"),
  )) as {
    status: string;
    apiCalls: number;
    steps?: {
      comparison?: {
        byteEqual: boolean;
        wasmHash: string;
        packageHash: string;
      };
    };
  };
  const evaluation = (await readJson(
    resolve(runDir, "evaluation", "evaluation.json"),
  )) as {
    status: string;
    taskId: string;
    packageHash: string;
    wasmHash: string;
    cases: { status: string }[];
    oracleReview: string;
  };
  if (
    !reproduction.steps?.comparison ||
    reproduction.steps.comparison.wasmHash !== evaluation.wasmHash ||
    reproduction.steps.comparison.packageHash !== evaluation.packageHash
  )
    throw new Error("access report evidence linkage mismatch");
  const summary = {
    version: 1,
    origin: "past-live-replay",
    taskId: evaluation.taskId,
    tasks: 1,
    plannedTrials: 1,
    completedTrials: reproduction.status === "pass" ? 1 : 0,
    reproductionStatus: reproduction.status,
    oracleStatus: evaluation.status,
    oracleReview: evaluation.oracleReview,
    oracleCases: evaluation.cases.length,
    oraclePass: evaluation.cases.filter((c) => c.status === "pass").length,
    byteEqual: reproduction.steps.comparison.byteEqual,
    wasmHash: evaluation.wasmHash,
    packageHash: evaluation.packageHash,
    apiCalls: reproduction.apiCalls,
    evidenceEligible: false,
    evidence: ["reproduction.json", "evaluation/evaluation.json"],
  };
  const output = resolve(outDir);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const csv = `"taskId","reproductionStatus","oracleStatus","oraclePass","oracleCases","byteEqual","wasmHash","packageHash"\n${[summary.taskId, summary.reproductionStatus, summary.oracleStatus, summary.oraclePass, summary.oracleCases, summary.byteEqual, summary.wasmHash, summary.packageHash].map(csvCell).join(",")}\n`;
  const md = `# Historical access case\n\n| Task | Reproduction | Oracle | Cases | Wasm byte equal |\n| --- | --- | --- | --- | --- |\n| ${summary.taskId} | ${summary.reproductionStatus} | ${summary.oracleStatus} | ${summary.oraclePass}/${summary.oracleCases} | ${summary.byteEqual} |\n\nOriginal live environment and Oracle review remain unconfirmed.\n`;
  await writeFile(
    resolve(output, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(resolve(output, "table.csv"), csv, { flag: "wx" });
  await writeFile(resolve(output, "table.md"), md, { flag: "wx" });
  return {
    summary,
    hashes: { csv: contentHash(csv), markdown: contentHash(md) },
  };
}
