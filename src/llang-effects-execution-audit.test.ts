import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeLlangCli } from "./llang-cli";
import { readVerifiedEffectsExecutionSnapshot } from "./llang-effects-bundle-inspection";
import { auditEffectsExecution } from "./llang-effects-execution-audit";
import { executeEffectsModuleBundle } from "./llang-effects-execution-evidence";
import { recoverEffectsExecution } from "./llang-effects-execution-recovery";
import {
  assertGrantSummaryWithinRequirement,
  parseEffectsRequirementDocument,
  readEffectsRequirementContract,
} from "./llang-effects-requirement-contract";
import { DEFAULT_EFFECTS_LIMITS } from "./llang-effects-contract";
import { EFFECTS_TRANSCRIPT_GENESIS } from "./llang-effects-transcript-writer";
import { buildEffectsModuleProgram } from "./llang-module-effects-build";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  options: { manual?: boolean; hostRequests?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "llang-effects-audit-"));
  temporary.push(root);
  const source = join(root, "main.llang.jsonc"),
    bundle = join(root, "bundle"),
    manifestPath = join(bundle, "module-build.json"),
    grantPath = join(root, "grant.json"),
    requirementsPath = join(root, "requirements.json");
  await writeFile(
    source,
    JSON.stringify({
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      module: "audit/main",
      entry: "main",
      imports: [],
      operations: [
        {
          id: "host.echo",
          version: 1,
          requestType: "string",
          responseType: "i64",
          errorType: { code: "string" },
          effect: "host",
          resource: "none",
          cancellable: true,
          idempotent: true,
        },
      ],
      resultType: "i64",
      nodes: [
        {
          kind: "await",
          operation: "host.echo",
          version: 1,
          request: "private-request-body",
        },
      ],
    }),
  );
  await buildEffectsModuleProgram({
    entry: "main.llang.jsonc",
    root,
    entryName: "main",
    target: "all",
    outDir: bundle,
  });
  const snapshot = await readVerifiedEffectsExecutionSnapshot(manifestPath),
    grant = {
      format: "llang-effects-grant",
      version: 1,
      bundleIdentityHash: snapshot.bundleIdentityHash,
      operations: ["host.echo@1"],
      file: null,
      http: null,
      wallClock: false,
      deadlineMs: 30_000,
      limits:
        options.hostRequests === undefined
          ? {}
          : { hostRequests: options.hostRequests },
    },
    requirements = requirementDocument(snapshot.bundleIdentityHash, {
      ...(options.manual === undefined ? {} : { manual: options.manual }),
    });
  await writeFile(grantPath, JSON.stringify(grant));
  await writeFile(requirementsPath, JSON.stringify(requirements));
  return {
    root,
    manifestPath,
    grantPath,
    requirementsPath,
    requirements,
  };
}

function requirementDocument(
  bundleIdentityHash: string,
  options: {
    manual?: boolean;
    ceilingHostRequests?: number;
    terminalStatus?: "cancelled" | "completed" | "failed" | "incomplete";
  } = {},
) {
  const terminalStatus = options.terminalStatus ?? "completed";
  const requirements = [
    {
      id: "finish",
      level: "must",
      statement: "The execution must complete.",
      verification: "outcome",
    },
    ...(options.manual
      ? [
          {
            id: "manual-review",
            level: "must",
            statement: "A domain owner must confirm the result meaning.",
            verification: "manual",
          },
        ]
      : []),
    {
      id: "run-host",
      level: "must",
      statement: "Invoke only the declared host operation.",
      verification: "structure",
    },
  ];
  return {
    format: "llang-effects-requirements",
    version: 1,
    id: "audit-main",
    revision: 1,
    body: "Execute the inspected operation under the fixed authority ceiling.",
    bundleIdentityHash,
    requirements,
    bindings: [
      {
        requirementId: "finish",
        nodes: [],
        operations: [],
        authorityRules: [],
        terminalStatuses: [terminalStatus],
      },
      {
        requirementId: "run-host",
        nodes: [0],
        operations: ["host.echo@1"],
        authorityRules: [],
        terminalStatuses: [],
      },
    ],
    authorityCeiling: {
      operations: ["host.echo@1"],
      file: null,
      http: null,
      wallClock: false,
      deadlineMs: 30_000,
      limits:
        options.ceilingHostRequests === undefined
          ? {}
          : { hostRequests: options.ceilingHostRequests },
    },
    expectedTerminalStatuses: [terminalStatus],
  };
}

async function rewriteEvidence(
  evidence: string,
  mutateEvents: (events: Record<string, unknown>[]) => void,
  mutateReport: (report: Record<string, unknown>) => void = () => undefined,
) {
  const transcriptPath = join(evidence, "effects-transcript.jsonl"),
    intentPath = join(evidence, "execution-intent.json"),
    reportPath = join(evidence, "effects-execution.json"),
    events = (await readFile(transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  mutateEvents(events);
  let previousHash = EFFECTS_TRANSCRIPT_GENESIS;
  for (const event of events) {
    delete event.eventHash;
    event.previousHash = previousHash;
    event.eventHash = fingerprintFor(event);
    previousHash = String(event.eventHash);
  }
  const transcriptText = `${events.map(stableJson).join("\n")}\n`,
    transcriptHash = sha256(transcriptText);
  await writeFile(transcriptPath, transcriptText);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<
      string,
      unknown
    >,
    transcript = report.transcript as Record<string, unknown>;
  transcript.events = events.length;
  transcript.bytes = Buffer.byteLength(transcriptText);
  transcript.fileHash = transcriptHash;
  transcript.firstHash = events[0]?.eventHash ?? null;
  transcript.finalHash = events.at(-1)?.eventHash ?? EFFECTS_TRANSCRIPT_GENESIS;
  mutateReport(report);
  const authenticity = report.authenticity as Record<string, unknown>;
  delete authenticity.evidenceHash;
  authenticity.evidenceHash = fingerprintFor({
    report,
    intentHash: sha256(await readFile(intentPath)),
    transcriptHash,
  });
  await writeFile(reportPath, `${stableJson(report)}\n`);
}

async function rewriteExecutionReport(
  evidence: string,
  mutate: (report: Record<string, unknown>) => void,
) {
  const intentPath = join(evidence, "execution-intent.json"),
    transcriptPath = join(evidence, "effects-transcript.jsonl"),
    reportPath = join(evidence, "effects-execution.json"),
    report = JSON.parse(await readFile(reportPath, "utf8")) as Record<
      string,
      unknown
    >;
  mutate(report);
  const authenticity = report.authenticity as Record<string, unknown>;
  delete authenticity.evidenceHash;
  authenticity.evidenceHash = fingerprintFor({
    report,
    intentHash: sha256(await readFile(intentPath)),
    transcriptHash: sha256(await readFile(transcriptPath)),
  });
  await writeFile(reportPath, `${stableJson(report)}\n`);
}

describe("requirement-bound effects execution audit", () => {
  test("binds requirements before execution and publishes a portable audit", async () => {
    const item = await fixture(),
      evidence = join(item.root, "evidence"),
      auditOutput = join(item.root, "audit"),
      execution = await executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        requirementsPath: item.requirementsPath,
        outputDirectory: evidence,
        execute: async () => 42n,
      });
    expect(execution).toMatchObject({
      version: 2,
      status: "completed",
      requirements: {
        status: "bound",
        id: "audit-main",
        changedAfterStart: false,
      },
      authority: { grantWithinCeiling: true, exceededRules: [] },
    });
    const executionText = await readFile(
        join(evidence, "effects-execution.json"),
        "utf8",
      ),
      intentText = await readFile(
        join(evidence, "execution-intent.json"),
        "utf8",
      );
    expect(executionText).not.toContain(item.requirements.body);
    expect(intentText).not.toContain(item.requirements.body);

    const audit = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: evidence,
      outputDirectory: auditOutput,
    });
    expect(audit).toMatchObject({
      format: "llang-effects-execution-audit",
      version: 1,
      status: "passed",
      authority: { grantWithinCeiling: true },
      requirements: {
        results: [
          { id: "finish", observations: { terminalStatus: "completed" } },
          {
            id: "run-host",
            observations: {
              events: 2,
              requests: 1,
              responses: 1,
              cleanup: 0,
              outcomes: { known: 1, unknown: 0 },
              resourceAttribution: "execution-level-only",
            },
          },
        ],
      },
      execution: {
        status: "completed",
        transcript: {
          observedOperations: ["host.echo@1"],
          unboundObservedOperations: [],
        },
      },
      checks: {
        failures: [],
        semanticMeaning: "not-proven",
        publisherAuthenticity: "not-proven",
        apiCalls: 0,
      },
      authenticity: { attestation: "not-signed" },
    });
    for (const name of [
      "execution-audit.json",
      "program.inspection.ts",
      "effects-transcript.jsonl",
      "effects-execution.json",
    ])
      expect((await readFile(join(auditOutput, name))).length).toBeGreaterThan(
        0,
      );
  });

  test("returns review-required when a mandatory manual requirement remains", async () => {
    const item = await fixture({ manual: true }),
      evidence = join(item.root, "evidence");
    await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      outputDirectory: evidence,
      execute: async () => 42n,
    });
    const audit = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: evidence,
    });
    expect(audit).toMatchObject({
      status: "review-required",
      requirements: { coverage: { manual: 1, reviewRequired: 1 } },
    });
  });

  test("audits expected failed and cancelled terminal statuses", async () => {
    const failed = await fixture(),
      failedEvidence = join(failed.root, "failed-evidence"),
      failedSnapshot = await readVerifiedEffectsExecutionSnapshot(
        failed.manifestPath,
      );
    await writeFile(
      failed.requirementsPath,
      JSON.stringify(
        requirementDocument(failedSnapshot.bundleIdentityHash, {
          terminalStatus: "failed",
        }),
      ),
    );
    await executeEffectsModuleBundle({
      manifestPath: failed.manifestPath,
      grantPath: failed.grantPath,
      requirementsPath: failed.requirementsPath,
      outputDirectory: failedEvidence,
      execute: async () => {
        throw new Error("expected-test-failure");
      },
    });
    expect(
      (
        await auditEffectsExecution({
          manifestPath: failed.manifestPath,
          requirementsPath: failed.requirementsPath,
          evidenceDirectory: failedEvidence,
        })
      ).status,
    ).toBe("passed");

    const cancelled = await fixture(),
      cancelledEvidence = join(cancelled.root, "cancelled-evidence"),
      cancelledSnapshot = await readVerifiedEffectsExecutionSnapshot(
        cancelled.manifestPath,
      ),
      grant = JSON.parse(await readFile(cancelled.grantPath, "utf8"));
    grant.deadlineMs = 1;
    await writeFile(cancelled.grantPath, JSON.stringify(grant));
    await writeFile(
      cancelled.requirementsPath,
      JSON.stringify(
        requirementDocument(cancelledSnapshot.bundleIdentityHash, {
          terminalStatus: "cancelled",
        }),
      ),
    );
    await executeEffectsModuleBundle({
      manifestPath: cancelled.manifestPath,
      grantPath: cancelled.grantPath,
      requirementsPath: cancelled.requirementsPath,
      outputDirectory: cancelledEvidence,
      execute: async () => new Promise(() => undefined),
    });
    expect(
      (
        await auditEffectsExecution({
          manifestPath: cancelled.manifestPath,
          requirementsPath: cancelled.requirementsPath,
          evidenceDirectory: cancelledEvidence,
        })
      ).status,
    ).toBe("passed");
  });

  test("audits relocated bundle, requirements, and evidence after source removal", async () => {
    const item = await fixture(),
      evidence = join(item.root, "evidence");
    await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      outputDirectory: evidence,
      execute: async () => 42n,
    });
    const relocated = await mkdtemp(join(tmpdir(), "llang-effects-relocated-"));
    temporary.push(relocated);
    await cp(join(item.root, "bundle"), join(relocated, "bundle"), {
      recursive: true,
    });
    await cp(evidence, join(relocated, "evidence"), { recursive: true });
    await cp(item.requirementsPath, join(relocated, "requirements.json"));
    await rm(item.root, { recursive: true });

    const audit = await auditEffectsExecution({
      manifestPath: join(relocated, "bundle/module-build.json"),
      requirementsPath: join(relocated, "requirements.json"),
      evidenceDirectory: join(relocated, "evidence"),
      outputDirectory: join(relocated, "audit"),
    });
    expect(audit.status).toBe("passed");
    expect(
      await readFile(join(relocated, "audit/execution-audit.json"), "utf8"),
    ).not.toContain(item.root);
  });

  test("classifies a tampered execution evidence hash as a failed audit", async () => {
    const item = await fixture(),
      evidence = join(item.root, "evidence");
    await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      outputDirectory: evidence,
      execute: async () => 42n,
    });
    const reportPath = join(evidence, "effects-execution.json"),
      report = JSON.parse(await readFile(reportPath, "utf8"));
    report.authenticity.evidenceHash = "0".repeat(64);
    await writeFile(reportPath, JSON.stringify(report));
    const audit = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: evidence,
    });
    expect(audit).toMatchObject({
      status: "failed",
      checks: { failures: ["evidence-hash"] },
    });
  });

  test("rejects unknown report fields before publishing audit artifacts", async () => {
    const item = await fixture(),
      evidence = join(item.root, "evidence"),
      auditOutput = join(item.root, "audit");
    await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      outputDirectory: evidence,
      execute: async () => 42n,
    });
    await rewriteEvidence(
      evidence,
      () => undefined,
      (report) => {
        report.payload = "must-not-be-published";
      },
    );
    expect(
      auditEffectsExecution({
        manifestPath: item.manifestPath,
        requirementsPath: item.requirementsPath,
        evidenceDirectory: evidence,
        outputDirectory: auditOutput,
      }),
    ).rejects.toThrow("INVALID_EFFECTS_EXECUTION_REPORT");
    expect(Bun.file(join(auditOutput, "effects-execution.json")).size).toBe(0);
  });

  test("accepts a structural requirement bound only by node index", async () => {
    const item = await fixture(),
      evidence = join(item.root, "node-binding-evidence"),
      requirements = {
        ...item.requirements,
        bindings: item.requirements.bindings.map((binding) =>
          binding.requirementId === "run-host"
            ? { ...binding, operations: [] }
            : binding,
        ),
      };
    await writeFile(item.requirementsPath, JSON.stringify(requirements));
    await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      outputDirectory: evidence,
      execute: async () => 42n,
    });
    expect(
      (
        await auditEffectsExecution({
          manifestPath: item.manifestPath,
          requirementsPath: item.requirementsPath,
          evidenceDirectory: evidence,
        })
      ).status,
    ).toBe("passed");
  });

  test("rejects an unbound observed operation even with recomputed hashes", async () => {
    const item = await fixture(),
      evidence = join(item.root, "evidence");
    await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      outputDirectory: evidence,
      execute: async () => 42n,
    });
    await rewriteEvidence(evidence, (events) => {
      for (const event of events)
        if (event.kind === "request" || event.kind === "response") {
          event.operation = "host.intruder@1";
          event.state = 99;
        }
    });

    const audit = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: evidence,
    });
    expect(audit).toMatchObject({
      status: "failed",
      execution: {
        transcript: {
          unboundObservedOperations: ["host.intruder@1"],
          ungrantedObservedOperations: ["host.intruder@1"],
        },
      },
    });
    expect((audit.checks as { failures: string[] }).failures).not.toContain(
      "evidence-hash",
    );
  });

  test("rejects response-operation and result-terminal inconsistencies", async () => {
    const item = await fixture(),
      responseEvidence = join(item.root, "response-mismatch-evidence");
    await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      outputDirectory: responseEvidence,
      execute: async () => 42n,
    });
    await rewriteEvidence(responseEvidence, (events) => {
      const response = events.find((event) => event.kind === "response");
      if (response) response.operation = "host.intruder@1";
    });
    const responseAudit = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: responseEvidence,
    });
    expect((responseAudit.checks as { failures: string[] }).failures).toContain(
      "transcript-operation-correlation",
    );

    const resultEvidence = join(item.root, "result-mismatch-evidence");
    await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      outputDirectory: resultEvidence,
      execute: async () => 42n,
    });
    await rewriteEvidence(
      resultEvidence,
      () => undefined,
      (report) => {
        report.status = "failed";
      },
    );
    const resultAudit = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: resultEvidence,
    });
    expect((resultAudit.checks as { failures: string[] }).failures).toContain(
      "execution-terminal-consistency",
    );
  });

  test("rejects inconsistent resource, cleanup, and timing summaries", async () => {
    const item = await fixture(),
      evidence = join(item.root, "summary-mismatch-evidence");
    await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      outputDirectory: evidence,
      execute: async () => 42n,
    });
    await rewriteExecutionReport(evidence, (report) => {
      const resource = report.resource as Record<string, unknown>,
        used = resource.used as Record<string, unknown>,
        cleanup = report.cleanup as Record<string, unknown>,
        timing = report.timing as Record<string, unknown>;
      used.hostRequests =
        Number((resource.peak as Record<string, unknown>).hostRequests) + 1;
      cleanup.unknownOutcomes = Number(cleanup.unknownOutcomes) + 1;
      timing.finishedAt = Number(timing.startedAt) - 1;
    });
    const audit = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: evidence,
    });
    expect((audit.checks as { failures: string[] }).failures).toEqual(
      expect.arrayContaining([
        "execution-resource-consistency",
        "execution-cleanup-consistency",
        "execution-timing-consistency",
      ]),
    );
  });

  test("rejects an authority increase before dispatch and evidence creation", async () => {
    const item = await fixture({ hostRequests: 2 }),
      document = requirementDocument(
        (await readVerifiedEffectsExecutionSnapshot(item.manifestPath))
          .bundleIdentityHash,
        { ceilingHostRequests: 1 },
      ),
      evidence = join(item.root, "rejected-evidence");
    await writeFile(item.requirementsPath, JSON.stringify(document));
    let dispatches = 0;
    await expect(
      executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        requirementsPath: item.requirementsPath,
        outputDirectory: evidence,
        execute: async () => {
          dispatches += 1;
          return 42n;
        },
      }),
    ).rejects.toThrow("EFFECTS_GRANT_EXCEEDS_REQUIREMENT_LIMIT");
    expect(dispatches).toBe(0);
    await expect(readFile(evidence)).rejects.toThrow();
  });

  test("marks a requirements replacement during execution as failed", async () => {
    const item = await fixture(),
      evidence = join(item.root, "changed-requirements-evidence"),
      execution = await executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        requirementsPath: item.requirementsPath,
        outputDirectory: evidence,
        execute: async () => {
          await writeFile(
            item.requirementsPath,
            JSON.stringify({ ...item.requirements, revision: 2 }),
          );
          return 42n;
        },
      });
    expect(execution).toMatchObject({
      status: "failed",
      result: { errorCode: "requirements-changed" },
      requirements: { changedAfterStart: true },
    });
    expect(
      (
        await auditEffectsExecution({
          manifestPath: item.manifestPath,
          requirementsPath: item.requirementsPath,
          evidenceDirectory: evidence,
        })
      ).status,
    ).toBe("failed");
  });

  test("recovers a version 2 child-process crash without replay", async () => {
    const item = await fixture(),
      evidence = join(item.root, "crash-evidence"),
      counter = join(item.root, "dispatch-count.txt"),
      snapshot = await readVerifiedEffectsExecutionSnapshot(item.manifestPath),
      requirements = requirementDocument(snapshot.bundleIdentityHash, {
        terminalStatus: "incomplete",
      });
    await writeFile(item.requirementsPath, JSON.stringify(requirements));
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "llang-effects-execution-crash-fixture.ts"),
        item.manifestPath,
        item.grantPath,
        evidence,
        counter,
        item.requirementsPath,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toBe("");
    expect(await readFile(counter, "utf8")).toBe("1");
    const recovered = await recoverEffectsExecution(evidence);
    expect(recovered).toMatchObject({
      version: 2,
      status: "incomplete",
      requirements: { status: "bound", id: "audit-main" },
      recovery: { replayedOperations: 0 },
    });
    expect(await readFile(counter, "utf8")).toBe("1");
    const auditOptions = {
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: evidence,
    };
    expect((await auditEffectsExecution(auditOptions)).status).toBe("passed");
    await rewriteExecutionReport(evidence, (report) => {
      (report.recovery as Record<string, unknown>).replayedOperations = 1;
    });
    expect(
      (
        (await auditEffectsExecution(auditOptions)).checks as {
          failures: string[];
        }
      ).failures,
    ).toContain("execution-recovery-consistency");
  });

  test("exposes strict CLI execution and audit options", async () => {
    const item = await fixture(),
      evidence = join(item.root, "cli-evidence"),
      auditOutput = join(item.root, "cli-audit");
    expect(
      await executeLlangCli([
        "module",
        "execute",
        item.manifestPath,
        "--grant",
        item.grantPath,
        "--requirements",
        item.requirementsPath,
        "--out-dir",
        evidence,
        "--json",
      ]),
    ).toMatchObject({ exitCode: 1, output: { version: 2, status: "failed" } });
    expect(
      await executeLlangCli([
        "module",
        "audit-execution",
        item.manifestPath,
        "--requirements",
        item.requirementsPath,
        "--evidence",
        evidence,
        "--out-dir",
        auditOutput,
        "--json",
      ]),
    ).toMatchObject({ exitCode: 1, output: { status: "failed" } });
    expect(
      await executeLlangCli([
        "module",
        "audit-execution",
        item.manifestPath,
        "--requirements",
        item.requirementsPath,
        "--bad",
        "value",
        "--json",
      ]),
    ).toMatchObject({ exitCode: 2, output: { ok: false } });
  });

  test("strictly validates requirement shapes and graph bindings", async () => {
    const item = await fixture();
    expect(() =>
      parseEffectsRequirementDocument({
        ...item.requirements,
        extra: true,
      }),
    ).toThrow("INVALID_EFFECTS_REQUIREMENT_DOCUMENT");
    await writeFile(
      item.requirementsPath,
      JSON.stringify({
        ...item.requirements,
        bindings: [
          item.requirements.bindings[0],
          { ...item.requirements.bindings[1], nodes: [99] },
        ],
      }),
    );
    const snapshot = await readVerifiedEffectsExecutionSnapshot(
      item.manifestPath,
    );
    await expect(
      readEffectsRequirementContract(
        item.requirementsPath,
        snapshot.bundleIdentityHash,
        snapshot.graph,
      ),
    ).rejects.toThrow("EFFECTS_REQUIREMENT_BINDING_MISMATCH");
    await writeFile(
      item.requirementsPath,
      JSON.stringify({
        ...item.requirements,
        requirements: [
          item.requirements.requirements[0],
          {
            id: "limit-host",
            level: "must",
            statement: "Bound the number of host requests.",
            verification: "authority",
          },
          item.requirements.requirements[1],
        ],
        bindings: [
          item.requirements.bindings[0],
          {
            requirementId: "limit-host",
            nodes: [],
            operations: [],
            authorityRules: ["limit/hostRequests"],
            terminalStatuses: [],
          },
          item.requirements.bindings[1],
        ],
        authorityCeiling: {
          ...item.requirements.authorityCeiling,
          limits: { hostRequests: 1 },
        },
      }),
    );
    await expect(
      readEffectsRequirementContract(
        item.requirementsPath,
        snapshot.bundleIdentityHash,
        snapshot.graph,
      ),
    ).resolves.toMatchObject({ coverage: { authority: 1 } });
  });

  test("checks every authority class when auditing a grant summary", async () => {
    const item = await fixture(),
      snapshot = await readVerifiedEffectsExecutionSnapshot(item.manifestPath),
      requirements = await readEffectsRequirementContract(
        item.requirementsPath,
        snapshot.bundleIdentityHash,
        snapshot.graph,
      ),
      base = {
        operations: ["host.echo@1"],
        file: null,
        http: null,
        wallClock: false,
        deadlineMs: 30_000,
        limits: { ...DEFAULT_EFFECTS_LIMITS },
      };
    expect(() =>
      assertGrantSummaryWithinRequirement(base, requirements),
    ).not.toThrow();
    expect(() =>
      assertGrantSummaryWithinRequirement(
        {
          ...base,
          file: {
            logicalRoots: ["input"],
            read: true,
            write: false,
            replace: false,
          },
        },
        requirements,
      ),
    ).toThrow("EFFECTS_GRANT_EXCEEDS_REQUIREMENT_FILE_AUTHORITY");
    expect(() =>
      assertGrantSummaryWithinRequirement(
        {
          ...base,
          http: {
            origins: ["https://example.com"],
            methods: ["GET"],
            requestHeaders: [],
            allowPublic: false,
            allowedAddresses: ["192.0.2.1"],
          },
        },
        requirements,
      ),
    ).toThrow("EFFECTS_GRANT_EXCEEDS_REQUIREMENT_HTTP_AUTHORITY");
    expect(() =>
      assertGrantSummaryWithinRequirement(
        { ...base, wallClock: true },
        requirements,
      ),
    ).toThrow("EFFECTS_GRANT_EXCEEDS_REQUIREMENT_AUTHORITY");
    expect(() =>
      assertGrantSummaryWithinRequirement(
        { ...base, deadlineMs: 30_001 },
        requirements,
      ),
    ).toThrow("EFFECTS_GRANT_EXCEEDS_REQUIREMENT_AUTHORITY");
    expect(() =>
      assertGrantSummaryWithinRequirement(
        {
          ...base,
          limits: {
            ...base.limits,
            hostRequests: DEFAULT_EFFECTS_LIMITS.hostRequests + 1,
          },
        },
        requirements,
      ),
    ).toThrow("INVALID_EFFECTS_GRANT_SUMMARY");
    expect(() =>
      assertGrantSummaryWithinRequirement(
        {
          ...base,
          limits: { ...base.limits, unexpected: 1 },
        },
        requirements,
      ),
    ).toThrow("INVALID_EFFECTS_GRANT_SUMMARY");
  });
});
