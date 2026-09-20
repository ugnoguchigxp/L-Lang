import {
  afterAll,
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  analyzeEffectsResultPackage,
  analyzeEffectsResultValue,
  assertEffectsTypeScriptBaselineSource,
  EffectsBenchmarkCommonHost,
  fixtureEffectsBenchmark,
  planEffectsBenchmark,
  reproduceEffectsResultPackage,
  runEffectsBenchmark,
  verifyEffectsResultPackage,
} from "./effects-adversarial-benchmark";
import { parseEffectsBenchmarkCliFlags } from "./effects-adversarial-cli";
import {
  EFFECTS_ATTACK_CATEGORIES,
  parseEffectsAdversarialStudy,
  parseEffectsFreeze,
  parseEffectsReview,
  verifyEffectsStudyFreeze,
} from "./effects-adversarial-study";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";

const studyPath = resolve("benchmarks/effects-adversarial-v1/study.json");
setDefaultTimeout(180_000);
const temporary: string[] = [];
let sharedFixtureRoot: string | undefined;
let sharedFixturePromise: ReturnType<typeof createFixture> | undefined;
afterAll(async () => {
  if (sharedFixtureRoot)
    await rm(sharedFixtureRoot, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

async function createFixture(isolated: boolean) {
  const root = await directory("effects-adversarial-test-");
  if (!isolated) {
    temporary.pop();
    sharedFixtureRoot = root;
  }
  const output = join(root, "run");
  const result = await fixtureEffectsBenchmark({
    studyPath,
    outputDirectory: output,
  });
  return { root, output, result };
}

async function fixture(isolated = false) {
  if (isolated) return createFixture(true);
  sharedFixturePromise ??= createFixture(false);
  return sharedFixturePromise;
}

function resign(value: Record<string, unknown>) {
  const unsigned = { ...value };
  delete unsigned.resultHash;
  return { ...unsigned, resultHash: fingerprintFor(unsigned) };
}

describe("Effects adversarial study and lifecycle", () => {
  test("rejects unknown, duplicate and valueless CLI options", () => {
    expect(
      parseEffectsBenchmarkCliFlags(
        ["--out-dir", "result", "--resume"],
        ["--out-dir"],
        ["--resume"],
      ).values["--out-dir"],
    ).toBe("result");
    expect(() => parseEffectsBenchmarkCliFlags(["--unknown"], [])).toThrow(
      "unknown option",
    );
    expect(() =>
      parseEffectsBenchmarkCliFlags(["--resume", "--resume"], [], ["--resume"]),
    ).toThrow("duplicate option");
    expect(() =>
      parseEffectsBenchmarkCliFlags(["--out-dir"], ["--out-dir"]),
    ).toThrow("requires a value");
  });

  test("validates the frozen exact file set and nine paired categories", async () => {
    const verified = await verifyEffectsStudyFreeze(studyPath);
    expect(verified.study.document.cases).toHaveLength(9);
    expect(
      verified.study.document.cases.map((item) => item.category).sort(),
    ).toEqual([...EFFECTS_ATTACK_CATEGORIES].sort());
    expect(verified.freeze.evidenceEligible).toBe(false);
    expect(verified.review.externalIdentityVerification).toBe("not-performed");
  });

  test("strictly rejects unknown, duplicate, unsafe and inconsistent study fields", async () => {
    const study = JSON.parse(await readFile(studyPath, "utf8"));
    expect(() =>
      parseEffectsAdversarialStudy({ ...study, unknown: true }),
    ).toThrow();
    expect(() =>
      parseEffectsAdversarialStudy({
        ...study,
        cases: [...study.cases, study.cases[0]],
      }),
    ).toThrow();
    expect(() =>
      parseEffectsAdversarialStudy({
        ...study,
        cases: study.cases.map(
          (item: Record<string, unknown>, index: number) =>
            index === 0 ? { ...item, task: "../escape.json" } : item,
        ),
      }),
    ).toThrow("PATH");
    expect(() =>
      parseEffectsAdversarialStudy({ ...study, evidenceEligible: true }),
    ).toThrow();
  });

  test("rejects extra files, symlinks and hard links", async () => {
    const parent = await directory("effects-exact-files-");
    const copy = join(parent, "copy");
    await cp(resolve("benchmarks/effects-adversarial-v1"), copy, {
      recursive: true,
    });
    await writeFile(join(copy, "extra.txt"), "extra");
    await expect(
      verifyEffectsStudyFreeze(join(copy, "study.json")),
    ).rejects.toThrow("EXACT_FILE_SET");
    await rm(join(copy, "extra.txt"));
    await symlink(join(copy, "review.json"), join(copy, "linked.json"));
    await expect(
      verifyEffectsStudyFreeze(join(copy, "study.json")),
    ).rejects.toThrow("LINK");
    await rm(join(copy, "linked.json"));
    await link(join(copy, "review.json"), join(copy, "hard.json"));
    await expect(
      verifyEffectsStudyFreeze(join(copy, "study.json")),
    ).rejects.toThrow("INVALID_EFFECTS_BENCHMARK_FILE");
  });

  test("rejects a replaced or symlinked output directory", async () => {
    const root = await directory("effects-output-identity-");
    const actual = join(root, "actual");
    const linked = join(root, "linked");
    await mkdir(actual);
    await symlink(actual, linked);
    await expect(
      runEffectsBenchmark({
        studyPath,
        outputDirectory: linked,
        resume: true,
      }),
    ).rejects.toThrow("OUTPUT_DIRECTORY_REPLACED");
  });

  test("binds review roles and fail-closed evidence eligibility", async () => {
    const fixtureReview = {
      format: "llang-effects-adversarial-review",
      version: 1,
      mode: "fixture",
      author: null,
      reviewer: null,
      targetHash: null,
      decision: "fixture",
      findings: [],
      resolutionHash: null,
      externalIdentityVerification: "not-performed",
    };
    expect(parseEffectsReview(fixtureReview).decision).toBe("fixture");
    expect(() =>
      parseEffectsReview({
        ...fixtureReview,
        mode: "reviewed",
        author: "same-person",
        reviewer: "same-person",
        decision: "approved",
        targetHash: "0".repeat(64),
      }),
    ).toThrow("INCONSISTENT");
    const freeze = JSON.parse(
      await readFile(
        resolve("benchmarks/effects-adversarial-v1/freeze.json"),
        "utf8",
      ),
    );
    expect(() =>
      parseEffectsFreeze(
        resign({ ...freeze, mode: "candidate", evidenceEligible: true }),
      ),
    ).toThrow();
  });

  test("keeps public inputs free of Oracle and threshold material", async () => {
    const study = JSON.parse(await readFile(studyPath, "utf8"));
    for (const item of study.cases) {
      for (const path of [item.task, item.normalInput, item.adversarialInput]) {
        const text = await readFile(
          resolve("benchmarks/effects-adversarial-v1", path),
          "utf8",
        );
        expect(text).not.toContain("expectedOperation");
        expect(text).not.toContain("expectedResultHash");
        expect(text).not.toContain("minimumPracticalDifference");
        expect(text).not.toContain(item.category);
      }
    }
  });
});

describe("Effects common host and paired arms", () => {
  test("enforces request, byte and stream budgets in the common host", async () => {
    const profile = {
      format: "llang-effects-benchmark-host" as const,
      version: 1 as const,
      id: "budget-test",
      virtualClockStartMs: 0,
      faultSeed: 1,
      network: "disabled" as const,
      filesystem: "virtual" as const,
    };
    const grant = {
      format: "llang-effects-benchmark-grant" as const,
      version: 1 as const,
      operations: ["benchmark.test@1"],
      targetHashes: [sha256("fixture://target")],
      requestLimit: 2,
      byteLimit: 8,
    };
    const requestLimited = new EffectsBenchmarkCommonHost(profile, grant, {
      requestLimit: 1,
      byteLimit: 8,
      streamChunkLimit: 2,
    });
    await expect(
      requestLimited.perform("benchmark.test@1", "fixture://target", "1234"),
    ).resolves.toBe("1234");
    await expect(
      requestLimited.perform("benchmark.test@1", "fixture://target", "1"),
    ).rejects.toThrow("OPERATION_BLOCKED");
    expect(requestLimited.events[1]?.status).toBe("blocked");

    const byteLimited = new EffectsBenchmarkCommonHost(profile, grant, {
      requestLimit: 2,
      byteLimit: 3,
      streamChunkLimit: 2,
    });
    await expect(
      byteLimited.perform("benchmark.test@1", "fixture://target", "1234"),
    ).rejects.toThrow("OPERATION_BLOCKED");
  });

  test("runs both real adapters through the same host, grant, input and fault schedule", async () => {
    const { result } = await fixture();
    expect(result.resultPackage.observations).toHaveLength(72);
    for (const observation of result.resultPackage.observations) {
      expect(observation.status).toBe("completed");
      expect(observation.apiCalls).toBe(0);
      expect(observation.events).toHaveLength(1);
      expect(stableJson(observation)).not.toContain(process.cwd());
      if (observation.arm === "llang") {
        expect(observation.llangChain).toMatchObject({
          executionEvidenceVersion: 4,
          fullChainVerified: true,
        });
      } else {
        expect(observation.llangChain).toBeNull();
      }
      const peer = result.resultPackage.observations.find(
        (item) =>
          item.caseId === observation.caseId &&
          item.variant === observation.variant &&
          item.repetition === observation.repetition &&
          item.arm !== observation.arm,
      );
      expect(peer).toBeDefined();
      expect(peer?.hostProfileHash).toBe(observation.hostProfileHash);
      expect(peer?.grantHash).toBe(observation.grantHash);
      expect(peer?.inputHash).toBe(observation.inputHash);
      expect(peer?.faultScheduleHash).toBe(observation.faultScheduleHash);
    }
  }, 120_000);

  test("quality-gates handwritten TypeScript source and forbidden APIs", async () => {
    const valid = await readFile(
      resolve(
        "benchmarks/effects-adversarial-v1/arms/typescript/case-01/baseline.ts",
      ),
      "utf8",
    );
    expect(() => assertEffectsTypeScriptBaselineSource(valid)).not.toThrow();
    for (const source of [
      valid.replace("BaselineInput", "any"),
      `${valid}\nfetch("https://example.invalid")`,
      `${valid}\nprocess.exit(0)`,
      `${valid}\nimport "node:fs"`,
      `${valid}\nimport { unsafe } from "./unsafe"`,
      valid.replace("input.task.operation", "input.input.content"),
    ])
      expect(() => assertEffectsTypeScriptBaselineSource(source)).toThrow(
        "UNSAFE_EFFECTS_TYPESCRIPT_BASELINE",
      );
  });

  test("normal pairs containing attack-like strings are not falsely rejected", async () => {
    const { result } = await fixture();
    const analysis = analyzeEffectsResultValue(result.resultPackage);
    expect(analysis.arms.every((arm) => arm.falseRejections === 0)).toBe(true);
    expect(analysis.attrition).toMatchObject({
      failed: 0,
      uncertain: 0,
      unknown: 0,
      excluded: 0,
    });
    expect(analysis.strata).toHaveLength(36);
    expect(
      analysis.strata.every(
        (item) => item.trials === 2 && item.cleanupCount === 2,
      ),
    ).toBe(true);
  });
});

describe("Effects runner, Oracle, analysis and reproduction", () => {
  test("is deterministic and counterbalances arm order", async () => {
    const first = await fixture();
    const second = await fixture(true);
    expect(first.result.resultPackage.resultHash).toBe(
      second.result.resultPackage.resultHash,
    );
    expect(first.result.resultPackage.trialOrder).toEqual(
      second.result.resultPackage.trialOrder,
    );
    const order = first.result.resultPackage.trialOrder;
    expect(
      order.some(
        (key, index) => key.includes("/typescript/") && index % 2 === 0,
      ),
    ).toBe(true);
    expect(
      order.some((key, index) => key.includes("/llang/") && index % 2 === 0),
    ).toBe(true);
    const plan = await planEffectsBenchmark(studyPath);
    expect(plan).toMatchObject({
      cases: 9,
      trials: 72,
      evidenceEligible: false,
    });
  });

  test("resume does not execute completed trials twice", async () => {
    const { root, output, result } = await fixture(true);
    const resumed = await runEffectsBenchmark({
      studyPath,
      outputDirectory: output,
      resume: true,
    });
    expect(resumed.resultPackage.resultHash).toBe(
      result.resultPackage.resultHash,
    );
    const tablePath = join(output, "table.csv");
    const expectedTable = await readFile(tablePath, "utf8");
    await rm(tablePath);
    await runEffectsBenchmark({
      studyPath,
      outputDirectory: output,
      resume: true,
    });
    expect(await readFile(tablePath, "utf8")).toBe(expectedTable);
    await writeFile(tablePath, "tampered\n");
    await expect(
      runEffectsBenchmark({
        studyPath,
        outputDirectory: output,
        resume: true,
      }),
    ).rejects.toThrow("DERIVED_ARTIFACT_MISMATCH");
    expect(await Bun.file(join(output, "run.lock")).exists()).toBe(false);
    await writeFile(tablePath, expectedTable);
    const lines = (await readFile(join(output, "observations.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(72);
    const tampered = JSON.parse(lines[0] as string);
    tampered.outputHash = "0".repeat(64);
    await writeFile(
      join(output, "observations.jsonl"),
      `${[stableJson(tampered), ...lines.slice(1)].join("\n")}\n`,
    );
    await expect(
      runEffectsBenchmark({
        studyPath,
        outputDirectory: output,
        resume: true,
      }),
    ).rejects.toThrow("CHECKPOINT_MISMATCH");
    expect(await Bun.file(join(output, "run.lock")).exists()).toBe(false);
    const outside = join(root, "outside-observations.jsonl");
    await writeFile(outside, `${lines.join("\n")}\n`);
    await rm(join(output, "observations.jsonl"));
    await symlink(outside, join(output, "observations.jsonl"));
    await expect(
      runEffectsBenchmark({
        studyPath,
        outputDirectory: output,
        resume: true,
      }),
    ).rejects.toThrow("INVALID_EFFECTS_TEXT_FILE");
    expect(await Bun.file(join(output, "run.lock")).exists()).toBe(false);
  });

  test("detects faulty observations for all nine attack categories", async () => {
    const { result } = await fixture();
    for (const category of EFFECTS_ATTACK_CATEGORIES) {
      const value = structuredClone(result.resultPackage) as unknown as Record<
        string,
        unknown
      >;
      const observations = value.observations as Record<string, unknown>[];
      const target = observations.find(
        (item) => item.category === category && item.variant === "adversarial",
      );
      if (!target) throw new Error(`missing category ${category}`);
      target.outputHash = "0".repeat(64);
      const analysis = analyzeEffectsResultValue(resign(value));
      expect(analysis.failures.some((failure) => failure.oracleMismatch)).toBe(
        true,
      );

      const faultyLog = structuredClone(
        result.resultPackage,
      ) as unknown as Record<string, unknown>;
      const logObservations = faultyLog.observations as Record<
        string,
        unknown
      >[];
      const logged = logObservations.find(
        (item) => item.category === category && item.variant === "adversarial",
      );
      if (!logged) throw new Error(`missing log category ${category}`);
      const oracle = (
        faultyLog.oracles as Record<string, Record<string, unknown>>
      )[String(logged.caseId)];
      const events = logged.events as Record<string, unknown>[];
      if (!oracle || !events[0]) throw new Error("missing mutation fixture");
      events[0].targetHash = (oracle.prohibitedTargetHashes as string[])[0];
      expect(
        analyzeEffectsResultValue(resign(faultyLog)).failures.some(
          (failure) => failure.oracleMismatch,
        ),
      ).toBe(true);

      const faultyOracle = structuredClone(
        result.resultPackage,
      ) as unknown as Record<string, unknown>;
      const oracles = faultyOracle.oracles as Record<
        string,
        Record<string, unknown>
      >;
      const changed = oracles[String(target.caseId)];
      if (!changed) throw new Error("missing Oracle mutation fixture");
      changed.expectedResultHash = "f".repeat(64);
      expect(() => analyzeEffectsResultValue(resign(faultyOracle))).toThrow(
        "HASH_MISMATCH",
      );
    }
  });

  test("rejects result tampering, missing, duplicate and unknown observations", async () => {
    const { result, output } = await fixture();
    const packagePath = join(output, "result-package.json");
    expect((await verifyEffectsResultPackage(packagePath)).status).toBe(
      "verified",
    );
    const freezePath = resolve("benchmarks/effects-adversarial-v1/freeze.json");
    expect(
      (await verifyEffectsResultPackage(packagePath, freezePath))
        .externalFreezeChecked,
    ).toBe(true);
    const changedFreeze = JSON.parse(await readFile(freezePath, "utf8"));
    changedFreeze.ownerRunApproval = true;
    delete changedFreeze.freezeHash;
    changedFreeze.freezeHash = fingerprintFor(changedFreeze);
    const changedFreezePath = join(output, "changed-freeze.json");
    await writeFile(changedFreezePath, `${stableJson(changedFreeze)}\n`);
    await expect(
      verifyEffectsResultPackage(packagePath, changedFreezePath),
    ).rejects.toThrow("EXTERNAL_FREEZE_MISMATCH");
    const raw = structuredClone(result.resultPackage) as unknown as Record<
      string,
      unknown
    >;
    expect(() => analyzeEffectsResultValue({ ...raw, extra: true })).toThrow();
    expect(() =>
      analyzeEffectsResultValue({ ...raw, resultHash: "0".repeat(64) }),
    ).toThrow("HASH_MISMATCH");
    const researchTamper = structuredClone(raw);
    const research = researchTamper.research as Record<string, unknown>;
    research.analysisPlan = {
      ...(research.analysisPlan as Record<string, unknown>),
      stopping: "changed-after-results",
    };
    expect(() => analyzeEffectsResultValue(resign(researchTamper))).toThrow();
    const oracleSourceTamper = structuredClone(raw);
    const bindings = oracleSourceTamper.oracleBindings as Record<
      string,
      Record<string, unknown>
    >;
    const binding = bindings[Object.keys(bindings)[0] as string];
    if (!binding) throw new Error("missing Oracle binding");
    binding.source = `${String(binding.source)} `;
    expect(() =>
      analyzeEffectsResultValue(resign(oracleSourceTamper)),
    ).toThrow();
    const missing = structuredClone(raw);
    (missing.observations as unknown[]).pop();
    expect(() => analyzeEffectsResultValue(resign(missing))).toThrow(
      "INCOMPLETE_EFFECTS_TRIAL_MATRIX",
    );
    const duplicate = structuredClone(raw);
    const observations = duplicate.observations as unknown[];
    observations.push(observations[0]);
    expect(() => analyzeEffectsResultValue(resign(duplicate))).toThrow(
      "INCOMPLETE_EFFECTS_TRIAL_MATRIX",
    );
  });

  test("regenerates raw-to-table artifacts without source execution", async () => {
    const { root, output, result } = await fixture();
    const packagePath = join(output, "result-package.json");
    const analysis = await analyzeEffectsResultPackage(packagePath);
    expect(analysis.analysis.evidenceEligible).toBe(false);
    expect(analysis.analysis.primary.every((item) => item.units === 9)).toBe(
      true,
    );
    const reproduction = await reproduceEffectsResultPackage({
      packagePath,
      outputDirectory: join(root, "reproduced"),
    });
    expect(reproduction.resultHash).toBe(result.resultPackage.resultHash);
    expect(reproduction).toMatchObject({
      apiCalls: 0,
      sourceExecution: 0,
      network: 0,
    });
    expect(await readFile(join(output, "table.csv"), "utf8")).toBe(
      await readFile(join(root, "reproduced", "table.csv"), "utf8"),
    );
    expect(await readFile(join(output, "figure.csv"), "utf8")).toBe(
      await readFile(join(root, "reproduced", "figure.csv"), "utf8"),
    );
    expect(await readFile(join(output, "report.md"), "utf8")).toContain(
      "threshold-not-met",
    );
    for (const name of [
      "README.md",
      "CLAIMS.md",
      "preregistration.md",
      "analysis-plan.json",
      "sample-size-plan.json",
      "dataset-manifest.json",
      "environment.json",
      "ethics-status.json",
      "independent-reproduction-record.template.json",
      "checksums.json",
      "raw/observations.jsonl",
      "derived/result.json",
      "tables/primary.csv",
      "figures/primary.csv",
      "scripts/README.md",
    ])
      expect(
        await Bun.file(
          join(root, "reproduced", "paper-artifact", name),
        ).exists(),
      ).toBe(true);
  });
});
