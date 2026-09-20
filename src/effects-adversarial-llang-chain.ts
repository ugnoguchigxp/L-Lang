import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { explainEffectsAttestation } from "./llang-effects-attestation-summary";
import { generateEffectsAttestationKeyPair } from "./llang-effects-attestation-crypto";
import {
  attestEffectsAudit,
  verifyEffectsAttestationPackage,
} from "./llang-effects-audit-attestation";
import { readVerifiedEffectsExecutionSnapshot } from "./llang-effects-bundle-inspection";
import { auditEffectsExecution } from "./llang-effects-execution-audit";
import { executeEffectsModuleBundle } from "./llang-effects-execution-evidence";
import { createEffectsRequirementApproval } from "./llang-effects-requirement-approval";
import { readEffectsRequirementContract } from "./llang-effects-requirement-contract";
import { buildEffectsModuleProgram } from "./llang-module-effects-build";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";

export async function executeActualEffectsAssuranceChain(options: {
  caseId: string;
  operation: string;
  target: string;
  invoke: () => Promise<void>;
  signingKeys?: EffectsBenchmarkChainSigningKeys;
}) {
  const root = await mkdtemp(join(tmpdir(), "llang-effects-benchmark-chain-"));
  try {
    const source = join(root, "main.llang.jsonc");
    const bundle = join(root, "bundle");
    const manifestPath = join(bundle, "module-build.json");
    const grantPath = join(root, "grant.json");
    const requirementsPath = join(root, "requirements.json");
    const operation =
      /^([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)@([1-9][0-9]*)$/u.exec(
        options.operation,
      );
    if (!operation) throw new Error("INVALID_EFFECTS_BENCHMARK_OPERATION");
    const operationId = operation[1] as string;
    const operationVersion = Number(operation[2]);
    const chainOperation = options.operation;
    await writeFile(
      source,
      `${stableJson({
        language: "l-lang",
        version: 5,
        kind: "module",
        profile: "module-effects-v1",
        module: `benchmark/${options.caseId}`,
        entry: "main",
        imports: [],
        operations: [
          {
            id: operationId,
            version: operationVersion,
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
            operation: operationId,
            version: operationVersion,
            request: options.target,
          },
        ],
      })}\n`,
    );
    await buildEffectsModuleProgram({
      entry: "main.llang.jsonc",
      root,
      entryName: "main",
      target: "all",
      outDir: bundle,
    });
    const snapshot = await readVerifiedEffectsExecutionSnapshot(manifestPath);
    await writeFile(
      grantPath,
      `${stableJson({
        format: "llang-effects-grant",
        version: 1,
        bundleIdentityHash: snapshot.bundleIdentityHash,
        operations: [chainOperation],
        file: null,
        http: null,
        wallClock: false,
        deadlineMs: 30_000,
        limits: { hostRequests: 1 },
      })}\n`,
    );
    const requirements = {
      format: "llang-effects-requirements",
      version: 1,
      id: `benchmark-${options.caseId}`,
      revision: 1,
      body: "Execute one frozen benchmark operation under the common host grant.",
      bundleIdentityHash: snapshot.bundleIdentityHash,
      requirements: [
        {
          id: "finish",
          level: "must",
          statement: "The execution must complete.",
          verification: "outcome",
        },
        {
          id: "run-host",
          level: "must",
          statement: "Invoke only the declared host operation.",
          verification: "structure",
        },
      ],
      bindings: [
        {
          requirementId: "finish",
          nodes: [],
          operations: [],
          authorityRules: [],
          terminalStatuses: ["completed"],
        },
        {
          requirementId: "run-host",
          nodes: [0],
          operations: [chainOperation],
          authorityRules: [],
          terminalStatuses: [],
        },
      ],
      authorityCeiling: {
        operations: [chainOperation],
        file: null,
        http: null,
        wallClock: false,
        deadlineMs: 30_000,
        limits: { hostRequests: 1 },
      },
      expectedTerminalStatuses: ["completed"],
    };
    await writeFile(requirementsPath, `${stableJson(requirements)}\n`);
    const parsedRequirements = await readEffectsRequirementContract(
      requirementsPath,
      snapshot.bundleIdentityHash,
      snapshot.graph,
    );
    const boundaryPath = join(root, "trust-data-boundary.json");
    await writeFile(
      boundaryPath,
      `${stableJson({
        format: "llang-effects-trust-boundary",
        version: 1,
        id: `benchmark-${options.caseId}-boundary`,
        revision: 1,
        requirements: {
          id: parsedRequirements.document.id,
          revision: parsedRequirements.document.revision,
          commitmentHash: parsedRequirements.commitmentHash,
        },
        sources: [
          {
            id: "host-response",
            operation: chainOperation,
            responsePath: [],
            classification: "untrusted-data",
          },
        ],
        sinks: [
          {
            id: "host-request",
            operation: chainOperation,
            requestPath: [],
            classification: "external-output",
          },
        ],
        allowedFlows: [
          {
            source: "host-response",
            sink: "host-request",
            purpose: "benchmark-roundtrip",
          },
        ],
        rules: {
          denyUnlistedFlows: true,
          denyDataDerivedAuthority: true,
          rawExternalDataInAudit: false,
        },
      })}\n`,
    );
    const approver =
      options.signingKeys?.approver ?? join(root, "approver-key");
    const host = options.signingKeys?.host ?? join(root, "host-key");
    const auditor = options.signingKeys?.auditor ?? join(root, "auditor-key");
    if (!options.signingKeys)
      await Promise.all([
        generateEffectsAttestationKeyPair(approver),
        generateEffectsAttestationKeyPair(host),
        generateEffectsAttestationKeyPair(auditor),
      ]);
    const publicKeys = await Promise.all(
      [approver, host, auditor].map(async (directory) =>
        JSON.parse(await readFile(join(directory, "public-key.json"), "utf8")),
      ),
    );
    const policyPath = join(root, "trust-policy.json");
    await writeFile(
      policyPath,
      `${stableJson({
        format: "llang-effects-trust-policy",
        version: 1,
        id: "benchmark.policy",
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
      })}\n`,
    );
    const approvalPath = join(root, "approval.json");
    await createEffectsRequirementApproval({
      manifestPath,
      requirementsPath,
      signingKeyPath: join(approver, "private-key.pem"),
      outputPath: approvalPath,
      trustBoundaryPath: boundaryPath,
    });
    const evidence = join(root, "evidence");
    const execution = await executeEffectsModuleBundle({
      manifestPath,
      grantPath,
      requirementsPath,
      approvalPath,
      trustPolicyPath: policyPath,
      hostSigningKeyPath: join(host, "private-key.pem"),
      trustBoundaryPath: boundaryPath,
      outputDirectory: evidence,
      execute: async () => {
        await options.invoke();
        return 7n;
      },
    });
    if (execution.status !== "completed" || execution.version !== 4)
      throw new Error("EFFECTS_BENCHMARK_LLANG_EXECUTION_FAILED");
    const audit = join(root, "audit");
    const auditResult = await auditEffectsExecution({
      manifestPath,
      requirementsPath,
      evidenceDirectory: evidence,
      trustPolicyPath: policyPath,
      requireAttestation: true,
      outputDirectory: audit,
    });
    if (auditResult.status !== "passed")
      throw new Error("EFFECTS_BENCHMARK_LLANG_AUDIT_FAILED");
    const packageDirectory = join(root, "package");
    await attestEffectsAudit({
      manifestPath,
      requirementsPath,
      auditDirectory: audit,
      trustPolicyPath: policyPath,
      signingKeyPath: join(auditor, "private-key.pem"),
      outputDirectory: packageDirectory,
    });
    const verified = await verifyEffectsAttestationPackage({
      manifestPath,
      requirementsPath,
      packageDirectory,
      trustPolicyPath: policyPath,
    });
    if (verified.status !== "trusted" || verified.auditStatus !== "passed")
      throw new Error("EFFECTS_BENCHMARK_LLANG_PACKAGE_FAILED");
    const summary = join(root, "summary");
    await explainEffectsAttestation({
      manifestPath,
      requirementsPath,
      packageDirectory,
      trustPolicyPath: policyPath,
      outputDirectory: summary,
    });
    await readFile(join(summary, "attestation-summary.json"));
    return Object.freeze({
      executionEvidenceVersion: 4 as const,
      requirementApprovalVersion: 2 as const,
      executionAttestationVersion: 2 as const,
      auditAttestationVersion: 2 as const,
      fullChainVerified: true as const,
      bundleIdentityHash: snapshot.bundleIdentityHash,
      requirementCommitmentHash: parsedRequirements.commitmentHash,
      trustBoundaryHash: sha256(await readFile(boundaryPath)),
      hostOperationHash: fingerprintFor({
        operation: chainOperation,
        targetHash: sha256(options.target),
      }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export type EffectsBenchmarkChainSigningKeys = Readonly<{
  root: string;
  approver: string;
  host: string;
  auditor: string;
}>;

export async function createEffectsBenchmarkChainSigningKeys(): Promise<EffectsBenchmarkChainSigningKeys> {
  const root = await mkdtemp(join(tmpdir(), "llang-effects-benchmark-keys-"));
  const keys = Object.freeze({
    root,
    approver: join(root, "approver-key"),
    host: join(root, "host-key"),
    auditor: join(root, "auditor-key"),
  });
  await Promise.all([
    generateEffectsAttestationKeyPair(keys.approver),
    generateEffectsAttestationKeyPair(keys.host),
    generateEffectsAttestationKeyPair(keys.auditor),
  ]);
  return keys;
}

export async function removeEffectsBenchmarkChainSigningKeys(
  keys: EffectsBenchmarkChainSigningKeys,
) {
  await rm(keys.root, { recursive: true, force: true });
}
