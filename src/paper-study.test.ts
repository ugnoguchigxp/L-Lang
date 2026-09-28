import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPaperReport, savePaperReport } from "./paper-report";
import { resumeStudy, runStudy, validateStudy } from "./paper-study";
import { contentHash } from "./prompt-source";

const draft = resolve("research/paper-v1/study-draft.json");
async function copyStudy(root: string) {
  const study = JSON.parse(await readFile(draft, "utf8"));
  for (const task of study.tasks)
    for (const key of ["source", "metadata", "oracle", "fixture"])
      if (task[key]) task[key] = resolve("research/paper-v1", task[key]);
  const path = resolve(root, "study.json");
  await writeFile(path, JSON.stringify(study));
  return { study, path };
}
test("draft validation exposes missing review and rejects bad task inputs", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-study-test-"));
  try {
    const { study, path } = await copyStudy(root);
    expect((await validateStudy(path)).readyForLive).toBe(false);
    await expect(runStudy(path, "live", resolve(root, "live"))).rejects.toThrow(
      "requires reviewed",
    );
    study.tasks.push({ ...study.tasks[0] });
    await writeFile(path, JSON.stringify(study));
    await expect(validateStudy(path)).rejects.toThrow("duplicate study task");
    study.tasks.pop();
    study.tasks[0].oracle = study.tasks[0].source;
    await writeFile(path, JSON.stringify(study));
    expect((await validateStudy(path)).diagnostics.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("fixture trials resume without duplicate calls and report is deterministic", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-study-run-"));
  try {
    const { path } = await copyStudy(root);
    const runDir = resolve(root, "run");
    const run = await runStudy(path, "fixture", runDir);
    expect(run.trials.map((t) => t.oracleStatus)).toEqual([
      "pass",
      "pass",
      "pass",
      "not-run",
    ]);
    expect((await resumeStudy(runDir)).trials).toEqual(run.trials);
    const one = await buildPaperReport(runDir);
    expect(one.tasks).toBe(4);
    expect(one.plannedTrials).toBe(4);
    expect(one.repairedPass).toBe(2);
    expect(one.evidenceEligible).toBe(false);
    await savePaperReport(runDir, resolve(root, "report-a"));
    await savePaperReport(runDir, resolve(root, "report-b"));
    expect(await readFile(resolve(root, "report-a/table.csv"), "utf8")).toBe(
      await readFile(resolve(root, "report-b/table.csv"), "utf8"),
    );
    const first = run.trials[0];
    if (!first) throw new Error("missing first trial");
    first.status = "uncertain";
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    await expect(resumeStudy(runDir)).rejects.toThrow("uncertain trial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("report and resume reject missing or relabeled trials", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-study-ledger-"));
  try {
    const { path } = await copyStudy(root);
    const runDir = resolve(root, "run");
    const run = await runStudy(path, "fixture", runDir);
    run.trials.pop();
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    const report = await buildPaperReport(runDir);
    expect(report.plannedTrials).toBe(4);
    expect(report.missingTrials).toBe(1);
    await expect(resumeStudy(runDir)).rejects.toThrow(
      "study trial plan mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("draft cannot become live-ready by filling review fields alone", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-study-state-"));
  try {
    const { study, path } = await copyStudy(root);
    study.tasks = [study.tasks[0]];
    const oracle = JSON.parse(await readFile(study.tasks[0].oracle, "utf8"));
    oracle.review = "reviewed";
    study.tasks[0].oracle = resolve(root, "oracle.json");
    await writeFile(study.tasks[0].oracle, JSON.stringify(oracle));
    study.tasks[0].review = "reviewed";
    study.review = "reviewed";
    study.approval = "granted";
    study.unresolved = [];
    study.model = "gpt-5.6-terra";
    study.provider = "codex-sdk";
    study.maxOutputTokens = 4096;
    study.maxTotalTokens = 100000;
    study.maxWallMs = 120000;
    study.budget = 3;
    await writeFile(path, JSON.stringify(study));
    study.frozenHashes = (await validateStudy(path)).hashes;
    await writeFile(path, JSON.stringify(study));
    expect((await validateStudy(path)).readyForLive).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("report keeps missing and failed trials in the denominator", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-study-report-"));
  try {
    const { path } = await copyStudy(root);
    const runDir = resolve(root, "run");
    const run = await runStudy(path, "fixture", runDir);
    const first = run.trials[0],
      second = run.trials[1];
    if (!first || !second) throw new Error("missing trial");
    await rm(resolve(runDir, "logic-1/oracle-evidence.json"));
    await rm(resolve(runDir, "contact-1/oracle-evidence.json"));
    first.status = "fail";
    first.oracleStatus = "not-run";
    const developmentPath = resolve(runDir, "logic-1/run.json");
    const development = JSON.parse(await readFile(developmentPath, "utf8"));
    development.status = "fail";
    development.attempts.at(-1).status = "fail";
    const { checksum: _oldChecksum, ...unsigned } = development;
    await writeFile(
      developmentPath,
      JSON.stringify({ ...unsigned, checksum: contentHash(unsigned) }),
    );
    second.status = "pending";
    second.oracleStatus = "not-run";
    second.development = null;
    second.calls = 0;
    second.tokens = 0;
    run.status = "running";
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    const report = await buildPaperReport(runDir);
    expect(report.plannedTrials).toBe(4);
    expect(report.completedTrials).toBe(3);
    expect(report.missingTrials).toBe(1);
    expect(report.firstPass + report.repairedPass).toBe(1);
    expect(report.oracleNotRun).toBe(3);
    await rm(resolve(runDir, "boundary-1/oracle-evidence.json"));
    for (const trial of run.trials) {
      trial.status = "pending";
      trial.oracleStatus = "not-run";
      trial.development = null;
      trial.calls = 0;
      trial.tokens = 0;
    }
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    const empty = await buildPaperReport(runDir);
    expect(empty.completedTrials).toBe(0);
    expect(empty.missingTrials).toBe(4);
    expect(empty.firstPass + empty.repairedPass + empty.oraclePass).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("source changes invalidate frozen review and budget stops fixture dispatch", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-study-boundaries-"));
  try {
    const { study, path } = await copyStudy(root);
    const originalSource = study.tasks[0].source;
    const validation = await validateStudy(path);
    study.frozenHashes = validation.hashes;
    await writeFile(path, JSON.stringify(study));
    expect((await validateStudy(path)).diagnostics).toEqual([]);
    const changed = JSON.parse(await readFile(study.tasks[0].source, "utf8"));
    delete changed.contract;
    const changedPath = resolve(root, "bad-source.json");
    await writeFile(changedPath, JSON.stringify(changed));
    study.tasks[0].source = changedPath;
    await writeFile(path, JSON.stringify(study));
    expect((await validateStudy(path)).diagnostics.length).toBeGreaterThan(0);
    study.tasks[0].source = originalSource;
    delete study.frozenHashes;
    study.budget = 2;
    await writeFile(path, JSON.stringify(study));
    const run = await runStudy(path, "fixture", resolve(root, "budget-run"));
    expect(
      run.trials.every((t) => t.status === "stopped" && t.calls === 0),
    ).toBe(true);
    const report = await buildPaperReport(resolve(root, "budget-run"));
    expect(report.plannedTrials).toBe(4);
    expect(report.firstPass + report.repairedPass).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("bad fixture response is recorded as error, and pre-dispatch failure stays uncertain", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-study-failures-"));
  try {
    const { study, path } = await copyStudy(root);
    const originalFixture = JSON.parse(
      await readFile(study.tasks[0].fixture, "utf8"),
    );
    originalFixture.responses[0].stage = "implementation";
    const invalidResponse = resolve(root, "invalid-response.json");
    await writeFile(invalidResponse, JSON.stringify(originalFixture));
    study.tasks[0].fixture = invalidResponse;
    await writeFile(path, JSON.stringify(study));
    const run = await runStudy(
      path,
      "fixture",
      resolve(root, "bad-response-run"),
    );
    expect(run.trials[0]?.status).toBe("error");
    expect(run.trials[0]?.development).toBe("logic-1/run.json");
    expect(run.trials[1]?.status).toBe("pass");

    study.tasks[0].fixture = resolve(root, "pre-dispatch.json");
    await writeFile(
      study.tasks[0].fixture,
      JSON.stringify({ version: 1, responses: "invalid" }),
    );
    await writeFile(path, JSON.stringify(study));
    await expect(
      runStudy(path, "fixture", resolve(root, "uncertain-run")),
    ).rejects.toThrow("invalid development fixtures");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("live approval must match a reviewed, frozen study", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-study-approval-"));
  try {
    const { study, path } = await copyStudy(root);
    study.tasks = [study.tasks[0]];
    const oracle = JSON.parse(await readFile(study.tasks[0].oracle, "utf8"));
    oracle.review = "reviewed";
    const reviewedOracle = resolve(root, "reviewed-oracle.json");
    await writeFile(reviewedOracle, JSON.stringify(oracle));
    study.tasks[0].oracle = reviewedOracle;
    study.tasks[0].review = "reviewed";
    study.review = "reviewed";
    study.state = "frozen";
    study.approval = "granted";
    study.unresolved = [];
    study.model = "gpt-5.6-terra";
    study.provider = "codex-sdk";
    study.maxOutputTokens = 4096;
    study.maxTotalTokens = 100000;
    study.maxWallMs = 120000;
    study.budget = 3;
    await writeFile(path, JSON.stringify(study));
    study.frozenHashes = (await validateStudy(path)).hashes;
    await writeFile(path, JSON.stringify(study));
    expect((await validateStudy(path)).readyForLive).toBe(true);
    const approval = resolve(root, "approval.json");
    await writeFile(
      approval,
      JSON.stringify({
        studyHash: "wrong",
        scope: "live",
        reviewer: "fixture",
        record: "fixture",
      }),
    );
    await expect(
      runStudy(path, "live", resolve(root, "live-run"), approval),
    ).rejects.toThrow("approval does not match study");
    expect(await Bun.file(resolve(root, "live-run/run.json")).exists()).toBe(
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-06/11/12/13/18/20 report never promotes mode-only or incomplete evidence", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase2-eligibility-"));
  try {
    const { path } = await copyStudy(root);
    const runDir = resolve(root, "run");
    const original = await runStudy(path, "fixture", runDir);
    const baseline = await buildPaperReport(runDir);
    expect(baseline.evidenceEligible).toBe(false);
    expect(baseline.eligibilityReasons).toContain("fixture-only");
    expect(baseline.eligibilityReasons).not.toContain(
      "oracle-evidence-not-recorded",
    );
    expect(baseline.eligibilityReasons).toContain(
      "study-evidence-verifier-pending",
    );
    expect(baseline.recordIntegrity).toBe("verified");
    const live = structuredClone(original);
    live.version = 1;
    delete (live as { inputSnapshotHash?: string }).inputSnapshotHash;
    live.mode = "live";
    live.approvalHash = null;
    live.approvalPath = null;
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(live));
    const modeOnly = await buildPaperReport(runDir);
    expect(modeOnly.evidenceEligible).toBe(false);
    expect(modeOnly.eligibilityReasons).toContain("approval-unavailable");
    expect(modeOnly.eligibilityReasons).toContain("study-not-ready");
    live.approvalHash = "a".repeat(64);
    live.approvalPath = resolve(root, "missing-approval.json");
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(live));
    expect((await buildPaperReport(runDir)).eligibilityReasons).toContain(
      "approval-unavailable",
    );
    await writeFile(
      live.approvalPath,
      JSON.stringify({
        studyHash: "wrong",
        scope: "live",
        reviewer: "test",
        record: "test",
      }),
    );
    expect((await buildPaperReport(runDir)).eligibilityReasons).toContain(
      "approval-mismatch",
    );
    const missing = structuredClone(original);
    missing.trials.pop();
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(missing));
    const report = await buildPaperReport(runDir);
    expect(report.plannedTrials).toBe(4);
    expect(report.recordedTrialCount).toBe(3);
    expect(report.missingTrials).toBe(1);
    expect(report.rows.at(-1)?.status).toBe("missing");
    expect(report.eligibilityReasons).toContain("run-status-inconsistent");
    await expect(resumeStudy(runDir)).rejects.toThrow(
      "study trial plan mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-09/10/17 report rejects changed records and shows absent development", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase2-records-"));
  try {
    const { path } = await copyStudy(root);
    const runDir = resolve(root, "run");
    const run = await runStudy(path, "fixture", runDir);
    run.version = 1;
    delete (run as { inputSnapshotHash?: string }).inputSnapshotHash;
    const first = run.trials[0];
    if (!first) throw new Error("missing trial");
    first.calls++;
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    await expect(buildPaperReport(runDir)).rejects.toThrow(
      "trial linkage mismatch",
    );
    first.calls--;
    first.oracleHash = "b".repeat(64);
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    await expect(buildPaperReport(runDir)).rejects.toThrow(
      "trial input hash mismatch",
    );
    first.oracleHash = (await validateStudy(path)).hashes[
      "logic:oracle"
    ] as string;
    first.development = "../escape/run.json";
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    await expect(buildPaperReport(runDir)).rejects.toThrow(
      "invalid trial path",
    );
    first.development = "logic-1/run.json";
    const originalDevelopment = await readFile(
      resolve(runDir, first.development),
      "utf8",
    );
    await rm(resolve(runDir, first.development));
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    const report = await buildPaperReport(runDir);
    expect(report.incompleteEvidenceTrials).toBe(1);
    expect(report.eligibilityReasons).toContain("development-evidence-missing");
    expect(report.rows[0]?.calls).toBeNull();
    expect(report.rows[0]?.suitePass).toBe(false);
    expect(report.oracleUnverified).toBe(1);
    expect(report.oracleNotRun).toBe(1);
    await expect(resumeStudy(runDir)).rejects.toThrow();
    const altered = JSON.parse(originalDevelopment);
    altered.logicalCalls++;
    await writeFile(
      resolve(runDir, first.development),
      JSON.stringify(altered),
    );
    await expect(buildPaperReport(runDir)).rejects.toThrow();
    await rm(resolve(runDir, first.id), { recursive: true });
    await symlink(resolve(root, "outside"), resolve(runDir, first.id));
    await expect(buildPaperReport(runDir)).rejects.toThrow("symbolic link");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-15/22 review material is deterministic and leaves inputs unchanged", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase2-review-"));
  try {
    const { path } = await copyStudy(root);
    const before = await readFile(path);
    const { saveStudyReview } = await import("./paper-study");
    const first = await saveStudyReview(path, resolve(root, "review-a"));
    const second = await saveStudyReview(path, resolve(root, "review-b"));
    expect(first.readyForLive).toBe(false);
    expect(first.tasks).toHaveLength(4);
    expect(first).toEqual(second);
    expect(await readFile(path)).toEqual(before);
    expect(await readFile(resolve(root, "review-a/review.md"), "utf8")).toBe(
      await readFile(resolve(root, "review-b/review.md"), "utf8"),
    );
    expect(
      await readFile(resolve(root, "review-a/review.md"), "utf8"),
    ).toContain("Existing-example tasks are not unknown or held-out tasks");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-19 invalid Oracle expectations block fixture dispatch", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase2-oracle-"));
  try {
    const { study, path } = await copyStudy(root);
    const oracle = JSON.parse(await readFile(study.tasks[0].oracle, "utf8"));
    oracle.cases[0].expected = { kind: "value", value: "true" };
    study.tasks[0].oracle = resolve(root, "invalid-oracle.json");
    await writeFile(study.tasks[0].oracle, JSON.stringify(oracle));
    await writeFile(path, JSON.stringify(study));
    expect((await validateStudy(path)).diagnostics.join(" ")).toContain(
      "invalid oracle cases",
    );
    const out = resolve(root, "run");
    await expect(runStudy(path, "fixture", out)).rejects.toThrow(
      "invalid oracle cases",
    );
    expect(await Bun.file(resolve(out, "run.json")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-22 review Markdown escapes pipes and newlines in requirements", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase2-markdown-"));
  try {
    const { study, path } = await copyStudy(root);
    const source = JSON.parse(await readFile(study.tasks[0].source, "utf8"));
    source.requirements[0].text = "left | right\n<script>";
    study.tasks[0].source = resolve(root, "special-source.json");
    await writeFile(study.tasks[0].source, JSON.stringify(source));
    await writeFile(path, JSON.stringify(study));
    const { saveStudyReview } = await import("./paper-study");
    await saveStudyReview(path, resolve(root, "review"));
    const md = await readFile(resolve(root, "review/review.md"), "utf8");
    expect(md).toContain("left \\| right<br>&lt;script&gt;");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-18 completed run with pending trial remains visible but cannot resume", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase2-pending-"));
  try {
    const { path } = await copyStudy(root);
    const runDir = resolve(root, "run");
    const run = await runStudy(path, "fixture", runDir);
    const trial = run.trials[0];
    if (!trial) throw new Error("missing trial");
    trial.status = "pending";
    trial.oracleStatus = "not-run";
    trial.development = null;
    trial.calls = 0;
    trial.tokens = 0;
    await rm(resolve(runDir, `${trial.id}/oracle-evidence.json`));
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    const report = await buildPaperReport(runDir);
    expect(report.plannedTrials).toBe(4);
    expect(report.missingTrials).toBe(1);
    expect(report.eligibilityReasons).toContain("run-status-inconsistent");
    await expect(resumeStudy(runDir)).rejects.toThrow(
      "completed study contains unfinished trials",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-20 all terminal with no Oracle remains ineligible", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase2-no-oracle-"));
  try {
    const { study, path } = await copyStudy(root);
    study.budget = 1;
    await writeFile(path, JSON.stringify(study));
    const runDir = resolve(root, "run");
    const run = await runStudy(path, "fixture", runDir);
    expect(run.trials.every((trial) => trial.status === "stopped")).toBe(true);
    const report = await buildPaperReport(runDir);
    expect(report.plannedTrials).toBe(4);
    expect(report.completedTrials).toBe(4);
    expect(report.oracleNotRun).toBe(4);
    expect(report.evidenceEligible).toBe(false);
    expect(report.eligibilityReasons).toContain(
      "study-evidence-verifier-pending",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-13 reviewed frozen study still lacks Oracle evidence", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase2-reviewed-"));
  try {
    const { study, path } = await copyStudy(root);
    study.tasks = [study.tasks[0]];
    const oracle = JSON.parse(await readFile(study.tasks[0].oracle, "utf8"));
    oracle.review = "reviewed";
    study.tasks[0].oracle = resolve(root, "oracle-reviewed.json");
    await writeFile(study.tasks[0].oracle, JSON.stringify(oracle));
    study.tasks[0].review = "reviewed";
    study.state = "frozen";
    study.review = "reviewed";
    study.approval = "granted";
    study.unresolved = [];
    study.model = "gpt-5.6-terra";
    study.provider = "codex-sdk";
    study.maxOutputTokens = 4096;
    study.maxTotalTokens = 100000;
    study.maxWallMs = 120000;
    study.budget = 3;
    await writeFile(path, JSON.stringify(study));
    study.frozenHashes = (await validateStudy(path)).hashes;
    await writeFile(path, JSON.stringify(study));
    const validation = await validateStudy(path);
    expect(validation.readyForLive).toBe(true);
    const runDir = resolve(root, "fixture");
    const run = await runStudy(path, "fixture", runDir);
    run.version = 1;
    delete (run as { inputSnapshotHash?: string }).inputSnapshotHash;
    run.mode = "live";
    const approval = {
      studyHash: validation.studyHash,
      scope: "live",
      reviewer: "fixture-test",
      record: "fixture-test",
    };
    run.approvalPath = resolve(root, "approval.json");
    run.approvalHash = contentHash(approval);
    await writeFile(run.approvalPath, JSON.stringify(approval));
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    const report = await buildPaperReport(runDir);
    expect(report.eligibilityReasons).not.toContain("study-not-ready");
    expect(report.eligibilityReasons).not.toContain("approval-mismatch");
    expect(report.eligibilityReasons).not.toContain(
      "oracle-evidence-not-recorded",
    );
    expect(report.eligibilityReasons).toContain(
      "study-evidence-verifier-pending",
    );
    expect(report.evidenceEligible).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-14 terminal failures, stopped and unfinished trials keep the planned denominator", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase2-denominator-"));
  try {
    const { path } = await copyStudy(root);
    const runDir = resolve(root, "run");
    const run = await runStudy(path, "fixture", runDir);
    expect((await buildPaperReport(runDir)).counts.unresolved).toBe(1);
    for (const trial of run.trials.filter((t) => t.status === "pass"))
      await rm(resolve(runDir, `${trial.id}/oracle-evidence.json`));
    for (const trial of run.trials) {
      trial.status = "fail";
      trial.oracleStatus = "not-run";
      trial.development = null;
      trial.calls = 0;
      trial.tokens = 0;
      trial.reason = "test-only missing record";
    }
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    const failed = await buildPaperReport(runDir);
    expect(failed.counts.fail).toBe(4);
    expect(failed.completedTrials).toBe(4);
    expect(failed.missingTrials).toBe(0);
    expect(failed.incompleteEvidenceTrials).toBe(4);
    expect(failed.suitePass).toBe(0);
    for (const trial of run.trials) {
      trial.status = "pending";
      trial.reason = null;
    }
    run.status = "running";
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    const pending = await buildPaperReport(runDir);
    expect(pending.counts.pending).toBe(4);
    expect(pending.missingTrials).toBe(4);
    for (const trial of run.trials) trial.status = "stopped";
    run.status = "complete";
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    const stopped = await buildPaperReport(runDir);
    expect(stopped.counts.stopped).toBe(4);
    expect(stopped.completedTrials).toBe(4);
    expect(stopped.suitePass).toBe(0);
    const firstStopped = run.trials[0];
    if (!firstStopped) throw new Error("missing stopped trial");
    firstStopped.reason = "=1+1";
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    await savePaperReport(runDir, resolve(root, "safe-csv"));
    expect(
      await readFile(resolve(root, "safe-csv/table.csv"), "utf8"),
    ).toContain('"\'=1+1"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate package and IR must match the recorded final attempt", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-candidate-link-"));
  try {
    const { path } = await copyStudy(root);
    const runDir = resolve(root, "run");
    await runStudy(path, "fixture", runDir);
    const recordPath = resolve(runDir, "logic-1/run.json");
    const originalDevelopment = await readFile(recordPath, "utf8");
    const development = JSON.parse(originalDevelopment);
    development.attempts.at(-1).packageHash = "a".repeat(64);
    const { checksum: _checksum, ...unsigned } = development;
    await writeFile(
      recordPath,
      JSON.stringify({ ...unsigned, checksum: contentHash(unsigned) }),
    );
    await expect(buildPaperReport(runDir)).rejects.toThrow(
      "candidate linkage mismatch",
    );
    await expect(resumeStudy(runDir)).rejects.toThrow(
      "candidate linkage mismatch",
    );
    await writeFile(recordPath, originalDevelopment);
    const candidateDir = resolve(
      runDir,
      "logic-1",
      `attempt-${development.attempts.length - 1}`,
      "candidate",
    );
    await rm(candidateDir, { recursive: true });
    await symlink(resolve(root, "outside-candidate"), candidateDir);
    await expect(buildPaperReport(runDir)).rejects.toThrow("symbolic link");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uncertain trial with a completed development record stays unfinished", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-partial-oracle-"));
  try {
    const { path } = await copyStudy(root);
    const runDir = resolve(root, "run");
    const run = await runStudy(path, "fixture", runDir);
    const trial = run.trials[0];
    if (!trial) throw new Error("missing trial");
    trial.status = "uncertain";
    trial.oracleStatus = "not-run";
    trial.reason = "Oracle evaluation interrupted";
    await rm(resolve(runDir, `${trial.id}/oracle-evidence.json`));
    run.status = "uncertain";
    await writeFile(resolve(runDir, "run.json"), JSON.stringify(run));
    const report = await buildPaperReport(runDir);
    expect(report.rows[0]?.status).toBe("uncertain");
    expect(report.rows[0]?.calls).toBe(3);
    expect(report.rows[0]?.suitePass).toBe(false);
    expect(report.missingTrials).toBe(1);
    expect(report.eligibilityReasons).toContain("unfinished-trials");
    await expect(resumeStudy(runDir)).rejects.toThrow("uncertain trial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
