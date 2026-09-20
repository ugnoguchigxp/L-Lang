import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { generateEffectsAttestationKeyPair } from "./llang-effects-attestation-crypto";
import { createEffectsRequirementApproval } from "./llang-effects-requirement-approval";
import {
  attestEffectsAudit,
  verifyEffectsAttestationPackage,
} from "./llang-effects-audit-attestation";
import { explainEffectsAttestation } from "./llang-effects-attestation-summary";

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
  test("creates and audits policy-bound signed execution evidence", async () => {
    const item = await fixture(),
      approverDirectory = join(item.root, "approver-key"),
      hostDirectory = join(item.root, "host-key"),
      auditorDirectory = join(item.root, "auditor-key");
    await generateEffectsAttestationKeyPair(approverDirectory);
    await generateEffectsAttestationKeyPair(hostDirectory);
    await generateEffectsAttestationKeyPair(auditorDirectory);
    const publicKeys = await Promise.all(
        [approverDirectory, hostDirectory, auditorDirectory].map(
          async (directory) =>
            JSON.parse(
              await readFile(join(directory, "public-key.json"), "utf8"),
            ) as {
              keyId: string;
              algorithm: "Ed25519";
              publicKeySpki: string;
            },
        ),
      ),
      policyPath = join(item.root, "trust-policy.json"),
      policy = {
        format: "llang-effects-trust-policy",
        version: 1,
        id: "test.policy",
        revision: 1,
        keys: publicKeys
          .map(({ keyId, algorithm, publicKeySpki }) => ({
            keyId,
            algorithm,
            publicKeySpki,
          }))
          .sort((left, right) => left.keyId.localeCompare(right.keyId)),
        roles: {
          requirementApprovers: [publicKeys[0]?.keyId],
          executionHosts: [publicKeys[1]?.keyId],
          auditors: [publicKeys[2]?.keyId],
        },
        revokedKeyIds: [],
        rules: {
          distinctRoleKeys: true,
          allowReviewRequired: false,
          allowRecoveredExecution: false,
        },
      },
      approvalPath = join(item.root, "approval.json"),
      evidence = join(item.root, "signed-evidence"),
      auditOutput = join(item.root, "signed-audit"),
      packageOutput = join(item.root, "attestation-package");
    await writeFile(policyPath, `${stableJson(policy)}\n`);
    await createEffectsRequirementApproval({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      signingKeyPath: join(approverDirectory, "private-key.pem"),
      outputPath: approvalPath,
    });
    const execution = await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      approvalPath,
      trustPolicyPath: policyPath,
      hostSigningKeyPath: join(hostDirectory, "private-key.pem"),
      outputDirectory: evidence,
      execute: async () => 1n,
    });
    expect(execution.status).toBe("completed");
    expect(
      JSON.parse(
        await readFile(join(evidence, "execution-attestation.json"), "utf8"),
      ).artifactKind,
    ).toBe("execution-attestation");
    const failedEvidence = join(item.root, "signed-failed-evidence"),
      failedExecution = await executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        requirementsPath: item.requirementsPath,
        approvalPath,
        trustPolicyPath: policyPath,
        hostSigningKeyPath: join(hostDirectory, "private-key.pem"),
        outputDirectory: failedEvidence,
        execute: async () => {
          throw new Error("fixture failure");
        },
      }),
      cancelledEvidence = join(item.root, "signed-cancelled-evidence"),
      cancelledController = new AbortController();
    cancelledController.abort(new Error("CANCELLED"));
    const cancelledExecution = await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      approvalPath,
      trustPolicyPath: policyPath,
      hostSigningKeyPath: join(hostDirectory, "private-key.pem"),
      outputDirectory: cancelledEvidence,
      signal: cancelledController.signal,
      execute: async () => 1n,
    });
    expect(failedExecution.status).toBe("failed");
    expect(cancelledExecution.status).toBe("cancelled");
    for (const [directory, status] of [
      [failedEvidence, "failed"],
      [cancelledEvidence, "cancelled"],
    ] as const) {
      const signed = JSON.parse(
        await readFile(join(directory, "execution-attestation.json"), "utf8"),
      ) as { payload: { execution: { status: string } } };
      expect(signed.payload.execution.status).toBe(status);
    }
    const audit = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: evidence,
      trustPolicyPath: policyPath,
      requireAttestation: true,
      outputDirectory: auditOutput,
    });
    expect(audit.status).toBe("passed");
    expect((audit.trust as { decision: string }).decision).toBe("trusted");
    expect(
      await readFile(join(auditOutput, "execution-attestation.json"), "utf8"),
    ).toBe(
      await readFile(join(evidence, "execution-attestation.json"), "utf8"),
    );
    await attestEffectsAudit({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      auditDirectory: auditOutput,
      trustPolicyPath: policyPath,
      signingKeyPath: join(auditorDirectory, "private-key.pem"),
      outputDirectory: packageOutput,
    });
    const verification = await verifyEffectsAttestationPackage({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      packageDirectory: packageOutput,
      trustPolicyPath: policyPath,
    });
    expect(verification).toMatchObject({
      status: "trusted",
      auditStatus: "passed",
      semanticMeaning: "not-proven",
      freshness: "not-proven",
      antiReplay: "not-provided",
      remoteAttestation: "not-provided",
      apiCalls: 0,
    });
    const assuredSnapshot = await readVerifiedEffectsExecutionSnapshot(
        item.manifestPath,
      ),
      assuredRequirements = await readEffectsRequirementContract(
        item.requirementsPath,
        assuredSnapshot.bundleIdentityHash,
        assuredSnapshot.graph,
      ),
      boundaryPath = join(item.root, "trust-data-boundary.json"),
      assuredApprovalPath = join(item.root, "assured-approval.json"),
      assuredEvidence = join(item.root, "assured-evidence"),
      assuredAudit = join(item.root, "assured-audit"),
      assuredPackage = join(item.root, "assured-package"),
      assuredSummary = join(item.root, "assured-summary"),
      assuredSummaryCopy = join(item.root, "assured-summary-copy");
    await writeFile(
      boundaryPath,
      `${stableJson({
        format: "llang-effects-trust-boundary",
        version: 1,
        id: "test.boundary",
        revision: 1,
        requirements: {
          id: assuredRequirements.document.id,
          revision: assuredRequirements.document.revision,
          commitmentHash: assuredRequirements.commitmentHash,
        },
        sources: [
          {
            id: "host-response",
            operation: "host.echo@1",
            responsePath: [],
            classification: "untrusted-data",
          },
        ],
        sinks: [
          {
            id: "host-request",
            operation: "host.echo@1",
            requestPath: [],
            classification: "external-output",
          },
        ],
        allowedFlows: [
          {
            source: "host-response",
            sink: "host-request",
            purpose: "fixture-roundtrip",
          },
        ],
        rules: {
          denyUnlistedFlows: true,
          denyDataDerivedAuthority: true,
          rawExternalDataInAudit: false,
        },
      })}\n`,
    );
    await createEffectsRequirementApproval({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      signingKeyPath: join(approverDirectory, "private-key.pem"),
      outputPath: assuredApprovalPath,
      trustBoundaryPath: boundaryPath,
    });
    const changedBoundaryPath = join(item.root, "changed-boundary.json"),
      changedBoundary = JSON.parse(await readFile(boundaryPath, "utf8"));
    changedBoundary.allowedFlows[0].purpose = "changed-purpose";
    await writeFile(changedBoundaryPath, `${stableJson(changedBoundary)}\n`);
    await expect(
      executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        requirementsPath: item.requirementsPath,
        approvalPath: assuredApprovalPath,
        trustPolicyPath: policyPath,
        hostSigningKeyPath: join(hostDirectory, "private-key.pem"),
        trustBoundaryPath: changedBoundaryPath,
        outputDirectory: join(item.root, "changed-boundary-evidence"),
        execute: async () => 7n,
      }),
    ).rejects.toThrow("EFFECTS_REQUIREMENT_APPROVAL_MISMATCH");
    const assuredExecution = await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      requirementsPath: item.requirementsPath,
      approvalPath: assuredApprovalPath,
      trustPolicyPath: policyPath,
      hostSigningKeyPath: join(hostDirectory, "private-key.pem"),
      trustBoundaryPath: boundaryPath,
      outputDirectory: assuredEvidence,
      execute: async () => 7n,
    });
    expect(assuredExecution.version).toBe(4);
    expect(assuredExecution).toMatchObject({
      trustData: {
        staticFlowStatus: "passed",
        observedFlowStatus: "matched",
        rawExternalDataRecorded: false,
      },
    });
    const assuredAuditReport = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: assuredEvidence,
      trustPolicyPath: policyPath,
      requireAttestation: true,
      outputDirectory: assuredAudit,
    });
    expect(assuredAuditReport.status).toBe("passed");
    await attestEffectsAudit({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      auditDirectory: assuredAudit,
      trustPolicyPath: policyPath,
      signingKeyPath: join(auditorDirectory, "private-key.pem"),
      outputDirectory: assuredPackage,
    });
    expect(
      (
        await verifyEffectsAttestationPackage({
          manifestPath: item.manifestPath,
          requirementsPath: item.requirementsPath,
          packageDirectory: assuredPackage,
          trustPolicyPath: policyPath,
        })
      ).status,
    ).toBe("trusted");
    await explainEffectsAttestation({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      packageDirectory: assuredPackage,
      trustPolicyPath: policyPath,
      outputDirectory: assuredSummary,
    });
    expect(
      await executeLlangCli([
        "module",
        "explain-attestation",
        item.manifestPath,
        "--requirements",
        item.requirementsPath,
        "--package",
        assuredPackage,
        "--trust-policy",
        policyPath,
        "--out-dir",
        assuredSummaryCopy,
        "--json",
      ]),
    ).toMatchObject({
      exitCode: 0,
      output: { status: "trusted", apiCalls: 0 },
    });
    for (const name of [
      "attestation-summary.json",
      "attestation-summary.md",
      "program.inspection.ts",
    ]) {
      const original = await readFile(join(assuredSummary, name));
      expect(original).toEqual(await readFile(join(assuredSummaryCopy, name)));
      if (name !== "program.inspection.ts") {
        expect(original.toString()).not.toContain("private-request-body");
        expect(original.toString()).not.toContain(item.root);
      }
    }
    await expect(
      explainEffectsAttestation({
        manifestPath: item.manifestPath,
        requirementsPath: item.requirementsPath,
        packageDirectory: assuredPackage,
        trustPolicyPath: policyPath,
        outputDirectory: join(assuredPackage, "overlapping-summary"),
      }),
    ).rejects.toThrow("EFFECTS_SUMMARY_OUTPUT_OVERLAP");
    expect(
      JSON.parse(
        await readFile(
          join(assuredSummary, "attestation-summary.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      verification: { status: "trusted", apiCalls: 0 },
      trustData: {
        authorityDerivation: "static-not-data-derived",
        rawExternalDataRecorded: false,
      },
    });
    const replacedPolicyPath = join(item.root, "replaced-policy.json");
    await writeFile(
      replacedPolicyPath,
      `${stableJson({
        ...policy,
        rules: { ...policy.rules, allowReviewRequired: true },
      })}\n`,
    );
    await expect(
      verifyEffectsAttestationPackage({
        manifestPath: item.manifestPath,
        requirementsPath: item.requirementsPath,
        packageDirectory: packageOutput,
        trustPolicyPath: replacedPolicyPath,
      }),
    ).rejects.toThrow("EFFECTS_TRUST_POLICY_ROLLBACK");
    const nextHostDirectory = join(item.root, "next-host-key");
    await generateEffectsAttestationKeyPair(nextHostDirectory);
    const nextHostPublic = JSON.parse(
        await readFile(join(nextHostDirectory, "public-key.json"), "utf8"),
      ) as {
        keyId: string;
        algorithm: "Ed25519";
        publicKeySpki: string;
      },
      transitionPolicyPath = join(item.root, "transition-policy.json"),
      transitionPolicy = {
        ...policy,
        revision: 2,
        keys: [
          ...policy.keys,
          {
            keyId: nextHostPublic.keyId,
            algorithm: nextHostPublic.algorithm,
            publicKeySpki: nextHostPublic.publicKeySpki,
          },
        ].sort((left, right) => left.keyId.localeCompare(right.keyId)),
        roles: {
          ...policy.roles,
          executionHosts: [publicKeys[1]?.keyId, nextHostPublic.keyId].sort(),
        },
      };
    await writeFile(transitionPolicyPath, `${stableJson(transitionPolicy)}\n`);
    const transitionAudit = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: evidence,
      trustPolicyPath: transitionPolicyPath,
      requireAttestation: true,
    });
    expect(transitionAudit.status).toBe("passed");
    expect(transitionAudit.trustDecision).toBe("trusted");
    expect(
      (
        await verifyEffectsAttestationPackage({
          manifestPath: item.manifestPath,
          requirementsPath: item.requirementsPath,
          packageDirectory: packageOutput,
          trustPolicyPath: transitionPolicyPath,
        })
      ).status,
    ).toBe("trusted");
    expect(
      (
        await verifyEffectsAttestationPackage({
          manifestPath: item.manifestPath,
          requirementsPath: item.requirementsPath,
          packageDirectory: assuredPackage,
          trustPolicyPath: transitionPolicyPath,
        })
      ).status,
    ).toBe("trusted");
    const retiredPolicyPath = join(item.root, "retired-policy.json");
    await writeFile(
      retiredPolicyPath,
      `${stableJson({
        ...transitionPolicy,
        revision: 3,
        roles: {
          ...transitionPolicy.roles,
          executionHosts: [nextHostPublic.keyId],
        },
        revokedKeyIds: [publicKeys[1]?.keyId],
      })}\n`,
    );
    expect(
      await executeLlangCli([
        "module",
        "audit-execution",
        item.manifestPath,
        "--requirements",
        item.requirementsPath,
        "--evidence",
        evidence,
        "--trust-policy",
        retiredPolicyPath,
        "--require-attestation",
        "--json",
      ]),
    ).toMatchObject({
      exitCode: 1,
      output: { trustDecision: "rejected" },
    });
    const relocated = join(item.root, "relocated-attestation");
    await mkdir(relocated);
    await Promise.all([
      cp(join(item.root, "bundle"), join(relocated, "bundle"), {
        recursive: true,
      }),
      cp(item.requirementsPath, join(relocated, "requirements.json")),
      cp(policyPath, join(relocated, "trust-policy.json")),
      cp(packageOutput, join(relocated, "package"), { recursive: true }),
      cp(assuredPackage, join(relocated, "assured-package"), {
        recursive: true,
      }),
    ]);
    await rm(join(item.root, "main.llang.jsonc"));
    expect(
      (
        await verifyEffectsAttestationPackage({
          manifestPath: join(relocated, "bundle/module-build.json"),
          requirementsPath: join(relocated, "requirements.json"),
          packageDirectory: join(relocated, "package"),
          trustPolicyPath: join(relocated, "trust-policy.json"),
        })
      ).status,
    ).toBe("trusted");
    expect(
      (
        await verifyEffectsAttestationPackage({
          manifestPath: join(relocated, "bundle/module-build.json"),
          requirementsPath: join(relocated, "requirements.json"),
          packageDirectory: join(relocated, "assured-package"),
          trustPolicyPath: join(relocated, "trust-policy.json"),
        })
      ).status,
    ).toBe("trusted");
    for (const name of [
      "requirements-approval.json",
      "execution-intent.json",
      "effects-transcript.jsonl",
      "effects-execution.json",
      "execution-audit.json",
    ]) {
      const tamperedPackage = join(
        item.root,
        `tampered-${name.replaceAll(".", "-")}`,
      );
      await cp(packageOutput, tamperedPackage, { recursive: true });
      await writeFile(join(tamperedPackage, name), " ", { flag: "a" });
      await expect(
        verifyEffectsAttestationPackage({
          manifestPath: item.manifestPath,
          requirementsPath: item.requirementsPath,
          packageDirectory: tamperedPackage,
          trustPolicyPath: policyPath,
        }),
      ).rejects.toThrow();
    }
    for (const name of [
      "program.inspection.ts",
      "effects-transcript.jsonl",
      "effects-execution.json",
      "execution-intent.json",
      "requirements-approval.json",
      "issuance-trust-policy.json",
      "execution-attestation.json",
      "execution-audit.json",
      "trust-data-boundary.json",
      "static-provenance.json",
      "audit-attestation.json",
    ]) {
      const tamperedPackage = join(
        item.root,
        `tampered-assured-${name.replaceAll(".", "-")}`,
      );
      await cp(assuredPackage, tamperedPackage, { recursive: true });
      await writeFile(join(tamperedPackage, name), " ", { flag: "a" });
      await expect(
        verifyEffectsAttestationPackage({
          manifestPath: item.manifestPath,
          requirementsPath: item.requirementsPath,
          packageDirectory: tamperedPackage,
          trustPolicyPath: policyPath,
        }),
      ).rejects.toThrow();
    }
    const rejectedSummaryPackage = join(item.root, "rejected-summary-package"),
      rejectedSummaryOutput = join(item.root, "rejected-summary-output");
    await cp(assuredPackage, rejectedSummaryPackage, { recursive: true });
    await writeFile(
      join(rejectedSummaryPackage, "trust-data-boundary.json"),
      " ",
      { flag: "a" },
    );
    expect(
      await executeLlangCli([
        "module",
        "explain-attestation",
        item.manifestPath,
        "--requirements",
        item.requirementsPath,
        "--package",
        rejectedSummaryPackage,
        "--trust-policy",
        policyPath,
        "--out-dir",
        rejectedSummaryOutput,
        "--json",
      ]),
    ).toMatchObject({ exitCode: 2, output: { ok: false } });
    await expect(readFile(rejectedSummaryOutput)).rejects.toThrow();
    const forgedRecovery = join(item.root, "forged-recovery-evidence");
    await cp(evidence, forgedRecovery, { recursive: true });
    await rm(join(forgedRecovery, "execution-attestation.json"));
    await rewriteExecutionReport(forgedRecovery, (report) => {
      (report.grant as Record<string, unknown>).sourceHash = "0".repeat(64);
    });
    await writeFile(
      join(forgedRecovery, "execution.lock"),
      `${stableJson({
        format: "llang-effects-execution-lock",
        version: 1,
        executionId: execution.executionId,
        ownerToken: "forged-report",
        pid: 2_147_483_647,
        startedAt: (execution.timing as { startedAt: number }).startedAt,
      })}\n`,
    );
    await expect(
      recoverEffectsExecution(forgedRecovery, {
        trustPolicyPath: policyPath,
        hostSigningKeyPath: join(hostDirectory, "private-key.pem"),
      }),
    ).rejects.toThrow("INVALID_SIGNED_RECOVERY_REPORT");
    await expect(
      readFile(join(forgedRecovery, "execution-attestation.json")),
    ).rejects.toThrow();
    await rm(join(evidence, "execution-attestation.json"));
    await writeFile(
      join(evidence, "execution.lock"),
      `${stableJson({
        format: "llang-effects-execution-lock",
        version: 1,
        executionId: execution.executionId,
        ownerToken: "crashed-after-report",
        pid: 2_147_483_647,
        startedAt: (execution.timing as { startedAt: number }).startedAt,
      })}\n`,
    );
    await recoverEffectsExecution(evidence, {
      trustPolicyPath: policyPath,
      hostSigningKeyPath: join(hostDirectory, "private-key.pem"),
    });
    const recoveredAttestation = JSON.parse(
      await readFile(join(evidence, "execution-attestation.json"), "utf8"),
    ) as { payload: { phase: string } };
    expect(recoveredAttestation.payload.phase).toBe("recovery-after-report");
    expect(
      (
        await auditEffectsExecution({
          manifestPath: item.manifestPath,
          requirementsPath: item.requirementsPath,
          evidenceDirectory: evidence,
          trustPolicyPath: policyPath,
          requireAttestation: true,
        })
      ).status,
    ).toBe("passed");
  }, 30_000);
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

  test("signs an incomplete version 4 recovery without replay", async () => {
    const item = await fixture(),
      snapshot = await readVerifiedEffectsExecutionSnapshot(item.manifestPath),
      requirements = requirementDocument(snapshot.bundleIdentityHash, {
        terminalStatus: "incomplete",
      }),
      approverDirectory = join(item.root, "recovery-approver-key"),
      hostDirectory = join(item.root, "recovery-host-key"),
      auditorDirectory = join(item.root, "recovery-auditor-key"),
      evidence = join(item.root, "signed-crash-evidence"),
      counter = join(item.root, "signed-dispatch-count.txt"),
      policyPath = join(item.root, "recovery-policy.json"),
      approvalPath = join(item.root, "recovery-approval.json"),
      boundaryPath = join(item.root, "recovery-boundary.json");
    await writeFile(item.requirementsPath, JSON.stringify(requirements));
    await generateEffectsAttestationKeyPair(approverDirectory);
    await generateEffectsAttestationKeyPair(hostDirectory);
    await generateEffectsAttestationKeyPair(auditorDirectory);
    const publicKeys = await Promise.all(
      [approverDirectory, hostDirectory, auditorDirectory].map(
        async (directory) =>
          JSON.parse(
            await readFile(join(directory, "public-key.json"), "utf8"),
          ) as {
            keyId: string;
            algorithm: "Ed25519";
            publicKeySpki: string;
          },
      ),
    );
    await writeFile(
      policyPath,
      `${stableJson({
        format: "llang-effects-trust-policy",
        version: 1,
        id: "test.recovery-policy",
        revision: 1,
        keys: publicKeys
          .map(({ keyId, algorithm, publicKeySpki }) => ({
            keyId,
            algorithm,
            publicKeySpki,
          }))
          .sort((left, right) => left.keyId.localeCompare(right.keyId)),
        roles: {
          requirementApprovers: [publicKeys[0]?.keyId],
          executionHosts: [publicKeys[1]?.keyId],
          auditors: [publicKeys[2]?.keyId],
        },
        revokedKeyIds: [],
        rules: {
          distinctRoleKeys: true,
          allowReviewRequired: false,
          allowRecoveredExecution: true,
        },
      })}\n`,
    );
    const parsedRequirements = await readEffectsRequirementContract(
      item.requirementsPath,
      snapshot.bundleIdentityHash,
      snapshot.graph,
    );
    await writeFile(
      boundaryPath,
      `${stableJson({
        format: "llang-effects-trust-boundary",
        version: 1,
        id: "test.recovery-boundary",
        revision: 1,
        requirements: {
          id: parsedRequirements.document.id,
          revision: parsedRequirements.document.revision,
          commitmentHash: parsedRequirements.commitmentHash,
        },
        sources: [
          {
            id: "host-response",
            operation: "host.echo@1",
            responsePath: [],
            classification: "untrusted-data",
          },
        ],
        sinks: [
          {
            id: "host-request",
            operation: "host.echo@1",
            requestPath: [],
            classification: "external-output",
          },
        ],
        allowedFlows: [
          {
            source: "host-response",
            sink: "host-request",
            purpose: "fixture-roundtrip",
          },
        ],
        rules: {
          denyUnlistedFlows: true,
          denyDataDerivedAuthority: true,
          rawExternalDataInAudit: false,
        },
      })}\n`,
    );
    await createEffectsRequirementApproval({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      signingKeyPath: join(approverDirectory, "private-key.pem"),
      outputPath: approvalPath,
      trustBoundaryPath: boundaryPath,
    });
    const childProcess = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "llang-effects-execution-crash-fixture.ts"),
        item.manifestPath,
        item.grantPath,
        evidence,
        counter,
        item.requirementsPath,
        approvalPath,
        policyPath,
        join(hostDirectory, "private-key.pem"),
        boundaryPath,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(await childProcess.exited).not.toBe(0);
    expect(await new Response(childProcess.stderr).text()).toBe("");
    const recovered = await recoverEffectsExecution(evidence, {
      trustPolicyPath: policyPath,
      hostSigningKeyPath: join(hostDirectory, "private-key.pem"),
    });
    expect(recovered).toMatchObject({
      version: 4,
      status: "incomplete",
      recovery: { replayedOperations: 0 },
      trustData: { observedFlowStatus: "incomplete" },
    });
    expect(await readFile(counter, "utf8")).toBe("1");
    const attestation = JSON.parse(
      await readFile(join(evidence, "execution-attestation.json"), "utf8"),
    ) as { payload: { phase: string } };
    expect(attestation.payload.phase).toBe("recovery-incomplete");
    const acceptedRecovery = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: evidence,
      trustPolicyPath: policyPath,
      requireAttestation: true,
    });
    expect(acceptedRecovery.status).toBe("passed");
    expect(acceptedRecovery.trustDecision).toBe("trusted");
    const rejectRecoveredPolicy = join(
      item.root,
      "reject-recovered-policy.json",
    );
    await writeFile(
      rejectRecoveredPolicy,
      `${stableJson({
        format: "llang-effects-trust-policy",
        version: 1,
        id: "test.recovery-policy",
        revision: 2,
        keys: publicKeys
          .map(({ keyId, algorithm, publicKeySpki }) => ({
            keyId,
            algorithm,
            publicKeySpki,
          }))
          .sort((left, right) => left.keyId.localeCompare(right.keyId)),
        roles: {
          requirementApprovers: [publicKeys[0]?.keyId],
          executionHosts: [publicKeys[1]?.keyId],
          auditors: [publicKeys[2]?.keyId],
        },
        revokedKeyIds: [],
        rules: {
          distinctRoleKeys: true,
          allowReviewRequired: false,
          allowRecoveredExecution: false,
        },
      })}\n`,
    );
    const rejectedRecovery = await auditEffectsExecution({
      manifestPath: item.manifestPath,
      requirementsPath: item.requirementsPath,
      evidenceDirectory: evidence,
      trustPolicyPath: rejectRecoveredPolicy,
      requireAttestation: true,
    });
    expect(rejectedRecovery.status).toBe("passed");
    expect(rejectedRecovery.auditStatus).toBe("passed");
    expect(rejectedRecovery.trustDecision).toBe("rejected");
  });

  test("exposes strict CLI execution and audit options", async () => {
    const item = await fixture(),
      evidence = join(item.root, "cli-evidence"),
      auditOutput = join(item.root, "cli-audit"),
      partialOutput = join(item.root, "partial-signed-evidence");
    expect(
      await executeLlangCli([
        "module",
        "execute",
        item.manifestPath,
        "--grant",
        item.grantPath,
        "--requirements",
        item.requirementsPath,
        "--approval",
        join(item.root, "unused-approval.json"),
        "--out-dir",
        partialOutput,
        "--json",
      ]),
    ).toMatchObject({ exitCode: 2, output: { ok: false } });
    await expect(readFile(partialOutput)).rejects.toThrow();
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
