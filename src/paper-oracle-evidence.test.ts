import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPaperReport } from "./paper-report";
import { resumeStudy, runStudy } from "./paper-study";
import {
  caseStatus,
  createOracleEvidence,
  evaluateCases,
  parseOracleEvidence,
  publishOracleEvidence,
  resultOf,
  verifyOracleEvidenceBody,
  verifyOracleEvidenceCheckpoint,
} from "./paper-oracle-evidence";
import { parseDevelopmentRun } from "./capability-development";
import { readCapability } from "./capability-package";
import { parsePaperOracle } from "./paper-evaluate";
import { contentHash, readJson } from "./prompt-source";
import { WasmError } from "./wasm-contract";

const study = resolve("research/paper-v1/study-draft.json");
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture value");
  return value;
}
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase3-"));
  const dir = resolve(root, "run");
  const run = await runStudy(study, "fixture", dir);
  const trial = required(run.trials[0]);
  const path = resolve(dir, `${trial.id}/oracle-evidence.json`);
  const raw = parseOracleEvidence(await readJson(path));
  return { root, dir, run, trial, path, raw };
}
const resign = (raw: Record<string, unknown>) => {
  const { checksum: _, ...body } = raw;
  return { ...body, checksum: contentHash(body) };
};

test("P3-01/03/16/17/18 fixture sidecars bind all cases and summary counts", async () => {
  const f = await fixture();
  try {
    const report = await buildPaperReport(f.dir);
    expect(report.version).toBe(2);
    expect(report.plannedTrials).toBe(4);
    expect(report.counts.pass).toBe(3);
    expect(report.counts.unresolved).toBe(1);
    expect(report.oraclePass).toBe(3);
    expect(report.oracleNotRun).toBe(1);
    expect(report.oracleUnverified).toBe(0);
    expect(report.evidenceEligible).toBe(false);
    expect(report.eligibilityReasons).not.toContain(
      "oracle-evidence-not-recorded",
    );
    let invalidInputCases = 0;
    for (const t of f.run.trials.filter((x) => x.status === "pass")) {
      const evidence = parseOracleEvidence(
        await readJson(resolve(f.dir, `${t.id}/oracle-evidence.json`)),
      );
      expect(evidence.cases.length).toBe(evidence.oracle.cases.length);
      invalidInputCases += evidence.cases.filter(
        (c) => c.actual.kind === "error" && c.actual.code === "INVALID_INPUT",
      ).length;
    }
    expect(invalidInputCases).toBeGreaterThan(0);
    const devRaw = await readJson(resolve(f.dir, `${f.trial.id}/run.json`));
    const dev = parseDevelopmentRun(devRaw);
    const pkg = await readCapability(resolve(f.dir, f.raw.candidatePath));
    const oracle = parsePaperOracle(f.raw.oracle);
    const a = createOracleEvidence(
      f.run,
      f.trial,
      devRaw,
      dev,
      pkg,
      oracle,
      f.raw.cases,
    );
    const b = createOracleEvidence(
      f.run,
      f.trial,
      devRaw,
      dev,
      pkg,
      oracle,
      f.raw.cases,
    );
    expect(a).toEqual(b);
    expect(a.developmentHash).toBe(contentHash(devRaw));
    expect(a.developmentHash).not.toBe(contentHash(dev));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P3-02/04/23 mismatch continues; execution error stops later cases", async () => {
  const f = await fixture();
  try {
    const oracle = parsePaperOracle(f.raw.oracle);
    let calls = 0;
    const wrong = evaluateCases(oracle, () => {
      calls++;
      return false;
    });
    expect(calls).toBe(oracle.cases.length);
    expect(resultOf(wrong)).toBe("fail");
    expect(wrong[0]?.status).toBe("fail");
    calls = 0;
    const errored = evaluateCases(oracle, () => {
      calls++;
      throw new Error("secret");
    });
    expect(calls).toBe(1);
    expect(errored.length).toBe(oracle.cases.length);
    expect(errored[0]?.actual).toEqual({
      kind: "execution-error",
      code: "EXECUTION_ERROR",
    });
    expect(errored.slice(1).every((c) => c.actual.kind === "not-run")).toBe(
      true,
    );
    expect(resultOf(errored)).toBe("error");
    const forgedInputError = evaluateCases(oracle, () => {
      throw { code: "INVALID_INPUT" };
    });
    expect(forgedInputError[0]?.actual).toEqual({
      kind: "execution-error",
      code: "EXECUTION_ERROR",
    });
    const contractError = evaluateCases(oracle, () => {
      throw new WasmError("INVALID_INPUT", "invalid contract input");
    });
    expect(contractError[0]?.actual).toEqual({
      kind: "error",
      code: "INVALID_INPUT",
    });
    expect(
      caseStatus(
        { kind: "error", code: "INVALID_INPUT" },
        { kind: "error", code: "INVALID_INPUT" },
      ),
    ).toBe("pass");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P3-05/06/07/20 malformed and forged sidecars fail strict parsing", async () => {
  const f = await fixture();
  try {
    const base = f.raw;
    const variants = [
      { ...base, cases: base.cases.slice(1) },
      { ...base, cases: [...base.cases, base.cases[0]] },
      {
        ...base,
        cases: [base.cases[0], base.cases[0], ...base.cases.slice(2)],
      },
      { ...base, cases: [...base.cases].reverse() },
      {
        ...base,
        cases: base.cases.map((c, i) =>
          i
            ? c
            : {
                ...c,
                expected: {
                  kind: "value",
                  value: c.expected.kind === "value" ? !c.expected.value : true,
                },
              },
        ),
      },
      {
        ...base,
        cases: base.cases.map((c, i) => (i ? c : { ...c, status: "fail" })),
      },
      { ...base, result: "fail" },
      { ...base, candidatePath: "../outside/capability.json" },
      { ...base, unknown: true },
      {
        ...base,
        cases: base.cases.map((c, i) =>
          i ? c : { ...c, actual: { kind: "value", value: "true" } },
        ),
      },
    ];
    for (const item of variants)
      expect(() => parseOracleEvidence(resign(item))).toThrow();
    expect(() =>
      parseOracleEvidence({ ...base, checksum: "0".repeat(64) }),
    ).toThrow();
    for (const key of ["trialId", "studyHash", "oracleHash"]) {
      const changed = resign({
        ...base,
        [key]: key === "trialId" ? "contact-1" : "a".repeat(64),
      });
      if (key === "trialId" || key === "oracleHash")
        expect(() => parseOracleEvidence(changed)).toThrow();
      else expect(() => parseOracleEvidence(changed)).not.toThrow();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P3-08/09/21/25 body and checkpoint checks bind saved development and candidate", async () => {
  const f = await fixture();
  try {
    const devRaw = await readJson(resolve(f.dir, `${f.trial.id}/run.json`));
    const dev = parseDevelopmentRun(devRaw);
    const oracle = parsePaperOracle(f.raw.oracle);
    const body = await verifyOracleEvidenceBody(
      f.dir,
      f.run,
      f.trial,
      f.raw,
      devRaw,
      dev,
      oracle,
    );
    expect(body.result).toBe("pass");
    await expect(
      verifyOracleEvidenceBody(
        f.dir,
        f.run,
        f.trial,
        f.raw,
        devRaw,
        { ...dev, sourceHash: "a".repeat(64) },
        oracle,
      ),
    ).rejects.toThrow();
    const pending = structuredClone(f.run);
    required(pending.trials[0]).oracleStatus = "not-run";
    pending.status = "uncertain";
    expect(() =>
      verifyOracleEvidenceCheckpoint(
        pending,
        required(pending.trials[0]),
        body,
      ),
    ).toThrow();
    expect(() =>
      verifyOracleEvidenceCheckpoint(f.run, f.trial, body),
    ).not.toThrow();
    const changed = resign({ ...f.raw, packageHash: "a".repeat(64) });
    await expect(
      verifyOracleEvidenceBody(
        f.dir,
        f.run,
        f.trial,
        changed,
        devRaw,
        dev,
        oracle,
      ),
    ).rejects.toThrow();
    for (const key of [
      "wasmHash",
      "contractHash",
      "sourceHash",
      "studyHash",
      "trialId",
    ]) {
      const forged = resign({
        ...f.raw,
        [key]: key === "trialId" ? "contact-1" : "a".repeat(64),
      });
      await expect(
        verifyOracleEvidenceBody(
          f.dir,
          f.run,
          f.trial,
          forged,
          devRaw,
          dev,
          oracle,
        ),
      ).rejects.toThrow();
    }
    await expect(
      verifyOracleEvidenceBody(
        f.dir,
        f.run,
        f.trial,
        f.raw,
        { ...(devRaw as Record<string, unknown>), extra: true },
        dev,
        oracle,
      ),
    ).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P3-10/11/17/26 old self-report and missing related evidence remain unverified", async () => {
  const f = await fixture();
  try {
    for (const t of f.run.trials.filter((x) => x.status === "pass"))
      await rm(resolve(f.dir, `${t.id}/oracle-evidence.json`));
    const old = await buildPaperReport(f.dir);
    expect(old.oraclePass).toBe(0);
    expect(old.oracleUnverified).toBe(3);
    expect(old.eligibilityReasons).toContain("oracle-evidence-not-recorded");
    await rm(resolve(f.dir, f.raw.candidatePath));
    expect((await buildPaperReport(f.dir)).eligibilityReasons).toContain(
      "oracle-evidence-incomplete",
    );
    await writeFile(f.path, JSON.stringify(f.raw));
    await rm(resolve(f.dir, `${f.trial.id}/run.json`));
    const incomplete = await buildPaperReport(f.dir);
    expect(incomplete.rows[0]?.oracleEvidenceHash).toBeNull();
    expect(incomplete.eligibilityReasons).toContain(
      "oracle-evidence-incomplete",
    );
    await writeFile(
      f.path,
      JSON.stringify({ ...f.raw, checksum: "0".repeat(64) }),
    );
    await expect(buildPaperReport(f.dir)).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("review: a missing development record cannot hide an uncheckpointed sidecar", async () => {
  const f = await fixture();
  try {
    const altered = structuredClone(f.run);
    required(altered.trials[0]).oracleStatus = "not-run";
    altered.status = "uncertain";
    await writeFile(resolve(f.dir, "run.json"), JSON.stringify(altered));
    await rm(resolve(f.dir, `${f.trial.id}/run.json`));
    await expect(buildPaperReport(f.dir)).rejects.toThrow("checkpoint");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P3-12/13/19/22/24/27/28 publication and runtime failures stop without resend", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase3-fail-"));
  const baseline = await fixture();
  try {
    const dir = resolve(root, "run");
    const run = await runStudy(study, "fixture", dir, undefined, {
      publish: async () => {
        throw new Error("publish failed");
      },
    });
    expect(run.status).toBe("uncertain");
    expect(run.trials[0]?.status).toBe("pass");
    expect(run.trials[0]?.oracleStatus).toBe("not-run");
    expect(run.trials[0]?.reason).toBeNull();
    expect(
      (
        (await readJson(resolve(dir, "logic-1/oracle-error.json"))) as Record<
          string,
          unknown
        >
      ).stage,
    ).toBe("publish");
    await expect(resumeStudy(dir)).rejects.toThrow("uncertain");
    const report = await buildPaperReport(dir);
    expect(report.recordIntegrity).toBe("incomplete");
    expect(report.eligibilityReasons).toContain("run-uncertain");
    const path = resolve(dir, "logic-1/oracle-evidence.json");
    const evidence = parseOracleEvidence(baseline.raw);
    await writeFile(path, JSON.stringify(evidence));
    await expect(publishOracleEvidence(path, evidence)).rejects.toThrow();
    expect(await readJson(path)).toEqual(evidence);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(baseline.root, { recursive: true, force: true });
  }
});

test("P3-02/18 mismatch sidecar keeps development pass and records failure", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase3-mismatch-"));
  try {
    const dir = resolve(root, "run");
    const run = await runStudy(study, "fixture", dir, undefined, {
      instantiate: async () => ({ evaluate: () => false }),
    });
    expect(run.status).toBe("complete");
    expect(run.trials[0]?.status).toBe("pass");
    expect(run.trials[0]?.oracleStatus).toBe("fail");
    const sidecar = parseOracleEvidence(
      await readJson(resolve(dir, "logic-1/oracle-evidence.json")),
    );
    expect(sidecar.result).toBe("fail");
    expect(sidecar.cases.length).toBe(sidecar.oracle.cases.length);
    const report = await buildPaperReport(dir);
    expect(report.oracleFail).toBeGreaterThan(0);
    expect(report.evidenceEligible).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P3-04/19/23 runtime exception writes error sidecar and fixed diagnostic", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase3-runtime-"));
  try {
    const dir = resolve(root, "run");
    let calls = 0;
    const run = await runStudy(study, "fixture", dir, undefined, {
      instantiate: async () => ({
        evaluate: () => {
          calls++;
          throw new Error("secret detail");
        },
      }),
    });
    expect(calls).toBe(1);
    expect(run.status).toBe("uncertain");
    expect(run.trials[0]?.status).toBe("pass");
    expect(run.trials[0]?.oracleStatus).toBe("not-run");
    const sidecar = parseOracleEvidence(
      await readJson(resolve(dir, "logic-1/oracle-evidence.json")),
    );
    expect(sidecar.result).toBe("error");
    expect(sidecar.cases.slice(1).every((c) => c.status === "not-run")).toBe(
      true,
    );
    const diagnostic = await readFile(
      resolve(dir, "logic-1/oracle-error.json"),
      "utf8",
    );
    expect(diagnostic).toContain("ORACLE_EXECUTION_FAILED");
    expect(diagnostic).not.toContain("secret detail");
    const report = await buildPaperReport(dir);
    expect(report.oracleExecutionError).toBe(1);
    expect(report.oracleNotRun).toBe(4);
    expect(report.rows[0]?.reason).toBe("");
    await expect(resumeStudy(dir)).rejects.toThrow("uncertain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P3-28 instantiate failure produces diagnostic without fabricated case rows", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase3-instantiate-"));
  try {
    const dir = resolve(root, "run");
    const run = await runStudy(study, "fixture", dir, undefined, {
      instantiate: async () => {
        throw new Error("secret compile error");
      },
    });
    expect(run.status).toBe("uncertain");
    expect(run.trials[0]?.oracleStatus).toBe("not-run");
    expect(
      (
        (await readJson(resolve(dir, "logic-1/oracle-error.json"))) as Record<
          string,
          unknown
        >
      ).stage,
    ).toBe("instantiate");
    expect(
      await Bun.file(resolve(dir, "logic-1/oracle-evidence.json")).exists(),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P3-14/15/21/27 report rejects symlink and uncheckpointed sidecar without executing", async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.path, "utf8");
    await rm(f.path);
    await symlink(resolve(f.dir, "contact-1/oracle-evidence.json"), f.path);
    await expect(buildPaperReport(f.dir)).rejects.toThrow();
    await rm(f.path);
    await writeFile(f.path, original);
    const run = structuredClone(f.run);
    required(run.trials[0]).oracleStatus = "not-run";
    run.status = "uncertain";
    await writeFile(resolve(f.dir, "run.json"), JSON.stringify(run));
    await expect(buildPaperReport(f.dir)).rejects.toThrow("checkpoint");
    await expect(resumeStudy(f.dir)).rejects.toThrow("uncertain");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("review: report verifies saved results without compiling or instantiating Wasm", async () => {
  const f = await fixture();
  const compile = required(
    Object.getOwnPropertyDescriptor(WebAssembly, "compile"),
  );
  const instantiate = required(
    Object.getOwnPropertyDescriptor(WebAssembly, "instantiate"),
  );
  try {
    Object.defineProperty(WebAssembly, "compile", {
      ...compile,
      value: () => {
        throw new Error("report executed Wasm");
      },
    });
    Object.defineProperty(WebAssembly, "instantiate", {
      ...instantiate,
      value: () => {
        throw new Error("report instantiated Wasm");
      },
    });
    expect((await buildPaperReport(f.dir)).oraclePass).toBe(3);
  } finally {
    Object.defineProperty(WebAssembly, "compile", compile);
    Object.defineProperty(WebAssembly, "instantiate", instantiate);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P3-22/29/30 pre-scoring checkpoint failure prevents Wasm execution", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase3-precheckpoint-"));
  try {
    let instantiations = 0;
    const dir = resolve(root, "run");
    const run = await runStudy(study, "fixture", dir, undefined, {
      saveRun: async (_dir, current) => {
        if (
          current.trials[0]?.status === "pass" &&
          current.status === "uncertain"
        )
          throw new Error("injected checkpoint fault");
        await writeFile(resolve(dir, "run.json"), JSON.stringify(current));
      },
      instantiate: async () => {
        instantiations++;
        return { evaluate: () => true };
      },
    });
    expect(instantiations).toBe(0);
    expect(run.status).toBe("uncertain");
    expect(run.trials[0]?.status).toBe("pass");
    expect(
      (
        (await readJson(resolve(dir, "logic-1/oracle-error.json"))) as Record<
          string,
          unknown
        >
      ).stage,
    ).toBe("checkpoint");
    await expect(resumeStudy(dir)).rejects.toThrow("uncertain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P3-29 post-checkpoint write exception retains saved state and resume does not regrade", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-phase3-postcheckpoint-"));
  try {
    const dir = resolve(root, "run");
    let injected = false;
    const run = await runStudy(study, "fixture", dir, undefined, {
      saveRun: async (_dir, current) => {
        await writeFile(resolve(dir, "run.json"), JSON.stringify(current));
        if (!injected && current.trials[0]?.oracleStatus === "pass") {
          injected = true;
          throw new Error("after write");
        }
      },
    });
    expect(injected).toBe(true);
    expect(run.status).toBe("uncertain");
    const saved = (await readJson(resolve(dir, "run.json"))) as {
      status: string;
      trials: { oracleStatus: string }[];
    };
    expect(saved.status).toBe("running");
    expect(required(saved.trials[0]).oracleStatus).toBe("pass");
    const originalEvidence = await readFile(
      resolve(dir, "logic-1/oracle-evidence.json"),
      "utf8",
    );
    const resumed = await resumeStudy(dir);
    expect(resumed.status).toBe("complete");
    expect(
      await readFile(resolve(dir, "logic-1/oracle-evidence.json"), "utf8"),
    ).toBe(originalEvidence);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P3-24 publish cleanup failure keeps final evidence and signals failure", async () => {
  const f = await fixture();
  try {
    const path = resolve(f.dir, "logic-1/oracle-evidence-copy.json");
    await expect(
      publishOracleEvidence(path, parseOracleEvidence(f.raw), {
        link: async (source, target) => {
          const fs = await import("node:fs/promises");
          await fs.link(source, target);
        },
        unlink: async () => {
          throw new Error("cleanup failed");
        },
      }),
    ).rejects.toThrow("cleanup failed");
    expect(parseOracleEvidence(await readJson(path))).toEqual(
      parseOracleEvidence(f.raw),
    );
    expect((await stat(path)).mode & 0o077).toBe(0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
