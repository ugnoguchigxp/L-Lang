import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  assertEffectsBundleIdentity,
  readVerifiedEffectsExecutionSnapshot,
} from "./llang-effects-bundle-inspection";
import {
  assertEffectsRequirementIdentity,
  assertGrantSummaryWithinRequirement,
  readEffectsRequirementContract,
} from "./llang-effects-requirement-contract";
import { pathsOverlap } from "./llang-effects-execution-grant";
import { DEFAULT_EFFECTS_LIMITS } from "./llang-effects-contract";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";
import {
  EFFECTS_TRANSCRIPT_GENESIS,
  parseEffectsTranscript,
} from "./llang-effects-transcript-writer";
import {
  assertCurrentPolicyForIssuance,
  assertEffectsTrustRole,
  readEffectsTrustPolicy,
} from "./llang-effects-trust-policy";
import { readAndVerifyEffectsRequirementApproval } from "./llang-effects-requirement-approval";
import { readAndVerifyEffectsExecutionAttestation } from "./llang-effects-execution-attestation";
import {
  effectsObservedFlowSummary,
  readEffectsTrustBoundary,
} from "./llang-effects-trust-boundary";

const HASH = /^[0-9a-f]{64}$/;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const LIMIT_NAMES = Object.keys(DEFAULT_EFFECTS_LIMITS);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

function exactChild(
  value: Record<string, unknown>,
  key: string,
  keys: readonly string[],
): Record<string, unknown> {
  const nested = value[key];
  if (!object(nested) || !exact(nested, keys))
    throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
  return nested;
}

function assertStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
}

export function assertExecutionEvidenceShape(
  intent: Record<string, unknown>,
  execution: Record<string, unknown>,
): void {
  const signed = intent.version === 3 || intent.version === 4,
    assured = intent.version === 4;
  if (
    !exact(intent, [
      "format",
      "version",
      "executionId",
      "bundleIdentityHash",
      "grantSourceHash",
      "grantCommitmentHash",
      "bundledWasmHash",
      "startedAt",
      "deadlineMs",
      "credentialInjection",
      "credentialHeaderNames",
      "grantSummary",
      "requirements",
      ...(signed ? ["attestation"] : []),
      ...(assured ? ["boundary"] : []),
    ])
  )
    throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
  exactChild(intent, "requirements", [
    "id",
    "revision",
    "sourceHash",
    "commitmentHash",
    "authorityCommitmentHash",
  ]);
  if (signed)
    exactChild(intent, "attestation", [
      "approvalSourceHash",
      "approvalPayloadHash",
      "approvalKeyId",
      "issuancePolicyId",
      "issuancePolicyRevision",
      "issuancePolicySourceHash",
      "issuancePolicyCommitmentHash",
      "hostKeyId",
    ]);
  if (assured)
    exactChild(intent, "boundary", [
      "id",
      "revision",
      "sourceHash",
      "commitmentHash",
      "provenanceHash",
    ]);
  assertStringArray(intent.credentialHeaderNames);

  const recovered = execution.recovered === true;
  if (
    !exact(
      execution,
      recovered
        ? [
            "format",
            "version",
            "executionId",
            "status",
            "recovered",
            "incompleteReason",
            "bundle",
            "grant",
            "requirements",
            "authority",
            "transcript",
            "result",
            "recovery",
            "credential",
            "authenticity",
            "limitations",
            ...(assured ? ["trustData"] : []),
          ]
        : [
            "format",
            "version",
            "executionId",
            "status",
            "bundle",
            "grant",
            "requirements",
            "authority",
            "runtime",
            "transcript",
            "result",
            "resource",
            "cleanup",
            "credential",
            "timing",
            "provenance",
            "authenticity",
            "limitations",
            ...(assured ? ["trustData"] : []),
          ],
    )
  )
    throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");

  exactChild(
    execution,
    "bundle",
    recovered
      ? ["bundleIdentityHash", "bundledWasmHash"]
      : [
          "bundleIdentityHash",
          "entry",
          "abi",
          "manifestHash",
          "bundledWasmHash",
          "inspectionVersion",
          "inspection",
          "bundleChangedAfterStart",
        ],
  );
  exactChild(
    execution,
    "grant",
    recovered
      ? ["sourceHash", "commitmentHash", "summary"]
      : ["sourceHash", "commitmentHash", "summary", "changedAfterStart"],
  );
  exactChild(
    execution,
    "requirements",
    recovered
      ? [
          "status",
          "id",
          "revision",
          "sourceHash",
          "commitmentHash",
          "authorityCommitmentHash",
          "bundleIdentityHash",
          "semanticMeaning",
        ]
      : [
          "status",
          "id",
          "revision",
          "sourceHash",
          "commitmentHash",
          "authorityCommitmentHash",
          "bundleIdentityHash",
          "coverage",
          "changedAfterStart",
          "semanticMeaning",
        ],
  );
  exactChild(execution, "authority", [
    "ceilingCommitmentHash",
    "grantWithinCeiling",
    "exceededRules",
  ]);
  exactChild(
    execution,
    "transcript",
    recovered
      ? [
          "format",
          "version",
          "path",
          "events",
          "bytes",
          "fileHash",
          "finalHash",
        ]
      : [
          "format",
          "version",
          "path",
          "events",
          "bytes",
          "fileHash",
          "firstHash",
          "finalHash",
        ],
  );
  const result = child(execution, "result");
  if (
    !exact(
      result,
      recovered
        ? ["status", "certainty", "pendingRequests"]
        : result.status === "completed"
          ? ["status", "resultHash", "resultType", "bytes", "certainty"]
          : ["status", "errorCode", "certainty"],
    )
  )
    throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
  if (recovered) {
    if (
      !Array.isArray(result.pendingRequests) ||
      !result.pendingRequests.every(
        (item) =>
          object(item) && exact(item, ["requestId", "operation", "certainty"]),
      )
    )
      throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
    const recovery = exactChild(execution, "recovery", [
      "staleOwner",
      "recoveredAt",
      "replayedOperations",
    ]);
    exactChild(recovery, "staleOwner", ["pid", "ownerTokenHash", "startedAt"]);
  } else {
    exactChild(execution, "runtime", [
      "bundledWasmHash",
      "stateContractHash",
      "stateCount",
      "hostRuntime",
    ]);
    const resource = exactChild(execution, "resource", [
      "limits",
      "used",
      "peak",
      "unreleased",
      "fuelUnit",
      "memoryUnit",
    ]);
    for (const name of ["limits", "used", "peak"] as const) {
      const values = resource[name];
      if (
        !object(values) ||
        !exact(values, LIMIT_NAMES) ||
        !Object.values(values).every(
          (value) => Number.isSafeInteger(value) && Number(value) >= 0,
        )
      )
        throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
    }
    const unreleased = resource.unreleased;
    if (
      !object(unreleased) ||
      Object.keys(unreleased).some(
        (name) =>
          ![
            "concurrentIo",
            "concurrentTasks",
            "openResources",
            "streams",
          ].includes(name) ||
          !Number.isSafeInteger(unreleased[name]) ||
          Number(unreleased[name]) < 0,
      )
    )
      throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
    exactChild(execution, "cleanup", [
      "attempted",
      "completed",
      "failures",
      "unknownOutcomes",
    ]);
    exactChild(execution, "timing", [
      "startedAt",
      "finishedAt",
      "durationMs",
      "durationClock",
    ]);
    exactChild(execution, "provenance", [
      "os",
      "arch",
      "bun",
      "compiler",
      "binaryen",
      "typescript",
    ]);
    const provenance = child(execution, "provenance");
    if (
      Object.values(provenance).some(
        (value) =>
          typeof value !== "string" || !/^[A-Za-z0-9._+-]{1,64}$/.test(value),
      )
    )
      throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
  }
  const credential = exactChild(execution, "credential", [
    "status",
    "headerNames",
    "values",
  ]);
  assertStringArray(credential.headerNames);
  exactChild(execution, "authenticity", [
    "attestation",
    "retention",
    ...(signed ? ["signerKeyId"] : []),
    "evidenceHash",
  ]);
  if (assured) {
    const trustData = exactChild(execution, "trustData", [
      "boundary",
      "staticProvenanceHash",
      "staticFlowStatus",
      "observedFlowStatus",
      "observedFlow",
      "observedFlowHash",
      "authorityDerivation",
      "rawExternalDataRecorded",
    ]);
    exactChild(trustData, "boundary", [
      "id",
      "revision",
      "sourceHash",
      "commitmentHash",
    ]);
    if (
      trustData.staticFlowStatus !== "passed" ||
      !["matched", "incomplete"].includes(
        String(trustData.observedFlowStatus),
      ) ||
      trustData.authorityDerivation !== "static-not-data-derived" ||
      trustData.rawExternalDataRecorded !== false
    )
      throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
  }
  assertStringArray(execution.limitations);
  if (
    fingerprintFor({ limitations: execution.limitations }) !==
    fingerprintFor({
      limitations: [
        "host-and-service-authenticity-not-proven",
        "business-correctness-not-proven",
        "external-side-effects-not-rolled-back",
      ],
    })
  )
    throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
}

export type EffectsExecutionAuditReport = Readonly<Record<string, unknown>> &
  Readonly<{ status: "passed" | "review-required" | "failed" }>;

const child = (
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const nested = value[key];
  if (!object(nested)) throw new Error("INVALID_EFFECTS_EXECUTION_REPORT");
  return nested;
};

async function durableCreateText(path: string, value: string): Promise<void> {
  const pending = resolve(
      dirname(path),
      `.${basename(path)}.${randomUUID()}.pending`,
    ),
    handle = await open(pending, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(pending, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(pending).catch(() => undefined);
  }
}

async function readJsonSnapshot(path: string) {
  const snapshot = await readStableRegularFileSnapshot(
      path,
      MAX_EVIDENCE_BYTES,
      "INVALID_EFFECTS_AUDIT_INPUT",
    ),
    value = parseStrictJsonObject(decodeUtf8(snapshot.bytes, path), path);
  if (!object(value)) throw new Error("INVALID_EFFECTS_AUDIT_INPUT");
  return Object.freeze({ ...snapshot, value });
}

export function executionEvidenceHashFor(
  report: Record<string, unknown>,
  intentHash: string,
  transcriptHash: string,
): string {
  const authenticity = child(report, "authenticity"),
    base = {
      ...report,
      authenticity: Object.fromEntries(
        Object.entries(authenticity).filter(([key]) => key !== "evidenceHash"),
      ),
    };
  return fingerprintFor({
    report: base,
    intentHash,
    transcriptHash,
  });
}

async function assertInputSnapshot(
  path: string,
  expected: Readonly<{ dev: number; ino: number; bytes: Uint8Array }>,
) {
  const current = await readStableRegularFileSnapshot(
    path,
    MAX_EVIDENCE_BYTES,
    "EFFECTS_AUDIT_INPUT_CHANGED",
  );
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    sha256(current.bytes) !== sha256(expected.bytes)
  )
    throw new Error("EFFECTS_AUDIT_INPUT_CHANGED");
}

async function prepareAuditOutput(
  manifestPath: string,
  requirementsPath: string,
  evidenceDirectory: string,
  outputDirectory: string,
) {
  const targetInput = resolve(outputDirectory),
    parentInfo = await lstat(dirname(targetInput));
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new Error("INVALID_EFFECTS_AUDIT_OUTPUT_PARENT");
  const parent = await realpath(dirname(targetInput)),
    target = resolve(parent, basename(targetInput)),
    bundleRoot = await realpath(dirname(resolve(manifestPath))),
    requirementsFile = await realpath(resolve(requirementsPath)),
    evidenceRoot = await realpath(resolve(evidenceDirectory));
  if (
    pathsOverlap(bundleRoot, target) ||
    pathsOverlap(requirementsFile, target) ||
    pathsOverlap(evidenceRoot, target)
  )
    throw new Error("EFFECTS_AUDIT_OUTPUT_OVERLAPS_INPUT");
  await mkdir(target);
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("INVALID_EFFECTS_AUDIT_OUTPUT");
  return Object.freeze({ path: target, dev: info.dev, ino: info.ino });
}

async function assertDirectoryIdentity(output: {
  path: string;
  dev: number;
  ino: number;
}) {
  const current = await lstat(output.path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== output.dev ||
    current.ino !== output.ino
  )
    throw new Error("EFFECTS_AUDIT_OUTPUT_CHANGED");
}

export async function auditEffectsExecution(options: {
  manifestPath: string;
  requirementsPath: string;
  evidenceDirectory: string;
  outputDirectory?: string;
  trustPolicyPath?: string;
  requireAttestation?: boolean;
}): Promise<EffectsExecutionAuditReport> {
  const snapshot = await readVerifiedEffectsExecutionSnapshot(
      options.manifestPath,
    ),
    requirements = await readEffectsRequirementContract(
      options.requirementsPath,
      snapshot.bundleIdentityHash,
      snapshot.graph,
    ),
    evidenceDirectory = resolve(options.evidenceDirectory),
    evidenceInfo = await lstat(evidenceDirectory);
  if (!evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink())
    throw new Error("INVALID_EFFECTS_AUDIT_EVIDENCE_DIRECTORY");
  const intentPath = resolve(evidenceDirectory, "execution-intent.json"),
    transcriptPath = resolve(evidenceDirectory, "effects-transcript.jsonl"),
    executionPath = resolve(evidenceDirectory, "effects-execution.json"),
    [intentSnapshot, executionSnapshot, transcriptSnapshot] = await Promise.all(
      [
        readJsonSnapshot(intentPath),
        readJsonSnapshot(executionPath),
        readStableRegularFileSnapshot(
          transcriptPath,
          MAX_EVIDENCE_BYTES,
          "INVALID_EFFECTS_AUDIT_INPUT",
        ),
      ],
    ),
    intent = intentSnapshot.value,
    execution = executionSnapshot.value,
    failures: string[] = [],
    policyRejections: string[] = [],
    transcriptEvents = parseEffectsTranscript(
      decodeUtf8(transcriptSnapshot.bytes, transcriptPath),
    ),
    transcript = Object.freeze({
      events: transcriptEvents,
      bytes: transcriptSnapshot.bytes.length,
      hash: sha256(transcriptSnapshot.bytes),
      finalHash:
        transcriptEvents.at(-1)?.eventHash ?? EFFECTS_TRANSCRIPT_GENESIS,
    });

  const signed =
      [3, 4].includes(Number(intent.version)) &&
      execution.version === intent.version,
    assured = intent.version === 4;
  if (
    intent.format !== "llang-effects-execution-intent" ||
    ![2, 3, 4].includes(Number(intent.version)) ||
    execution.format !== "llang-effects-execution" ||
    execution.version !== intent.version ||
    (options.requireAttestation && !signed)
  )
    throw new Error("EFFECTS_EXECUTION_REQUIREMENTS_NOT_BOUND");
  if (signed !== Boolean(options.trustPolicyPath))
    throw new Error("SIGNED_AUDIT_REQUIRES_TRUST_POLICY");
  assertExecutionEvidenceShape(intent, execution);

  const intentRequirements = child(intent, "requirements"),
    intentGrantSummary = child(intent, "grantSummary"),
    reportRequirements = child(execution, "requirements"),
    reportBundle = child(execution, "bundle"),
    reportGrant = child(execution, "grant"),
    reportGrantSummary = child(reportGrant, "summary"),
    reportAuthority = child(execution, "authority"),
    reportTranscript = child(execution, "transcript"),
    reportAuthenticity = child(execution, "authenticity"),
    reportCredential = child(execution, "credential"),
    reportResult = child(execution, "result"),
    recovered = execution.recovered === true,
    reportResource = object(execution.resource)
      ? execution.resource
      : undefined,
    reportCleanup = object(execution.cleanup) ? execution.cleanup : undefined,
    reportTiming = object(execution.timing) ? execution.timing : undefined,
    reportRecovery = object(execution.recovery)
      ? execution.recovery
      : undefined,
    reportTrustData = object(execution.trustData)
      ? execution.trustData
      : undefined,
    boundary = assured
      ? await readEffectsTrustBoundary(
          resolve(evidenceDirectory, "trust-data-boundary.json"),
          requirements,
          snapshot.graph,
        )
      : undefined,
    observedFlow = boundary
      ? effectsObservedFlowSummary(boundary, transcript.events)
      : undefined;
  if (boundary && observedFlow) {
    const intentBoundary = child(intent, "boundary"),
      checkedTrustData = child(execution, "trustData"),
      reportBoundary = child(checkedTrustData, "boundary"),
      provenancePath = resolve(evidenceDirectory, "static-provenance.json"),
      provenanceSnapshot = await readJsonSnapshot(provenancePath);
    if (
      intentBoundary.id !== boundary.document.id ||
      intentBoundary.revision !== boundary.document.revision ||
      intentBoundary.sourceHash !== boundary.sourceHash ||
      intentBoundary.commitmentHash !== boundary.commitmentHash ||
      intentBoundary.provenanceHash !== boundary.provenanceHash ||
      reportBoundary.id !== boundary.document.id ||
      reportBoundary.revision !== boundary.document.revision ||
      reportBoundary.sourceHash !== boundary.sourceHash ||
      reportBoundary.commitmentHash !== boundary.commitmentHash ||
      checkedTrustData.staticProvenanceHash !== boundary.provenanceHash ||
      checkedTrustData.observedFlowHash !== fingerprintFor(observedFlow) ||
      !object(checkedTrustData.observedFlow) ||
      fingerprintFor(checkedTrustData.observedFlow) !==
        fingerprintFor(observedFlow) ||
      fingerprintFor(provenanceSnapshot.value) !==
        fingerprintFor(boundary.provenance)
    )
      throw new Error("EFFECTS_TRUST_BOUNDARY_BINDING_MISMATCH");
  }
  const signedTrust = signed
    ? await (async () => {
        const issuancePolicyPath = resolve(
            evidenceDirectory,
            "issuance-trust-policy.json",
          ),
          approvalPath = resolve(
            evidenceDirectory,
            "requirements-approval.json",
          ),
          attestationPath = resolve(
            evidenceDirectory,
            "execution-attestation.json",
          ),
          issuancePolicy = await readEffectsTrustPolicy(issuancePolicyPath),
          currentPolicy = await readEffectsTrustPolicy(
            options.trustPolicyPath as string,
          );
        assertCurrentPolicyForIssuance(issuancePolicy, currentPolicy);
        const approval = await readAndVerifyEffectsRequirementApproval({
          approvalPath,
          snapshot,
          requirements,
          policy: issuancePolicy,
          ...(boundary ? { boundary } : {}),
        });
        assertEffectsTrustRole(
          currentPolicy,
          "requirementApprovers",
          approval.document.keyId,
        );
        const approvalCurrent = await readAndVerifyEffectsRequirementApproval({
          approvalPath,
          snapshot,
          requirements,
          policy: currentPolicy,
          ...(boundary ? { boundary } : {}),
        });
        const attestation = await readAndVerifyEffectsExecutionAttestation({
          path: attestationPath,
          policy: issuancePolicy,
        });
        assertEffectsTrustRole(
          currentPolicy,
          "executionHosts",
          attestation.document.keyId,
        );
        await readAndVerifyEffectsExecutionAttestation({
          path: attestationPath,
          policy: currentPolicy,
        });
        const intentAttestation = child(intent, "attestation"),
          expectedPayload = {
            format: "llang-effects-execution-attestation",
            version: boundary ? 2 : 1,
            executionId: String(execution.executionId),
            phase: recovered
              ? "recovery-incomplete"
              : attestation.payload.phase,
            approval: {
              sourceHash: approval.sourceHash,
              payloadHash: approval.document.payloadHash,
              keyId: approval.document.keyId,
            },
            issuancePolicy: {
              id: issuancePolicy.document.id,
              revision: issuancePolicy.document.revision,
              sourceHash: issuancePolicy.sourceHash,
              commitmentHash: issuancePolicy.commitmentHash,
            },
            intentHash: sha256(intentSnapshot.bytes),
            bundle: {
              bundleIdentityHash: String(reportBundle.bundleIdentityHash),
              bundledWasmHash: String(reportBundle.bundledWasmHash),
            },
            requirements: {
              sourceHash: String(reportRequirements.sourceHash),
              commitmentHash: String(reportRequirements.commitmentHash),
              authorityCommitmentHash: String(
                reportRequirements.authorityCommitmentHash,
              ),
            },
            grant: {
              sourceHash: String(reportGrant.sourceHash),
              commitmentHash: String(reportGrant.commitmentHash),
            },
            transcript: {
              fileHash: transcript.hash,
              finalHash: transcript.finalHash,
              events: transcript.events.length,
            },
            execution: {
              reportHash: sha256(executionSnapshot.bytes),
              evidenceHash: String(reportAuthenticity.evidenceHash),
              status: execution.status,
              certainty: reportResult.certainty,
              cleanupCommitmentHash: fingerprintFor(
                (execution.cleanup ?? {}) as object,
              ),
              resourceCommitmentHash: fingerprintFor(
                (execution.resource ?? {}) as object,
              ),
              replayedOperations: recovered
                ? Number(reportRecovery?.replayedOperations)
                : 0,
            },
            ...(boundary && observedFlow
              ? {
                  boundary: {
                    sourceHash: boundary.sourceHash,
                    commitmentHash: boundary.commitmentHash,
                    provenanceHash: boundary.provenanceHash,
                    observedFlowHash: fingerprintFor(observedFlow),
                  },
                }
              : {}),
          };
        if (
          fingerprintFor(attestation.payload) !==
            fingerprintFor(expectedPayload) ||
          (recovered
            ? attestation.payload.phase !== "recovery-incomplete"
            : !["normal", "recovery-after-report"].includes(
                attestation.payload.phase,
              )) ||
          intentAttestation.approvalSourceHash !== approval.sourceHash ||
          intentAttestation.approvalPayloadHash !==
            approval.document.payloadHash ||
          intentAttestation.approvalKeyId !== approval.document.keyId ||
          intentAttestation.issuancePolicyId !== issuancePolicy.document.id ||
          intentAttestation.issuancePolicyRevision !==
            issuancePolicy.document.revision ||
          intentAttestation.issuancePolicySourceHash !==
            issuancePolicy.sourceHash ||
          intentAttestation.issuancePolicyCommitmentHash !==
            issuancePolicy.commitmentHash ||
          intentAttestation.hostKeyId !== attestation.document.keyId ||
          approvalCurrent.document.payloadHash !== approval.document.payloadHash
        )
          throw new Error("EFFECTS_ATTESTATION_BINDING_MISMATCH");
        return Object.freeze({
          issuancePolicy,
          currentPolicy,
          approval,
          attestation,
          paths: Object.freeze({
            issuancePolicyPath,
            approvalPath,
            attestationPath,
          }),
        });
      })()
    : undefined;
  const signedInputSnapshots = signedTrust
    ? new Map(
        await Promise.all(
          [
            ["requirements-approval.json", signedTrust.paths.approvalPath],
            [
              "issuance-trust-policy.json",
              signedTrust.paths.issuancePolicyPath,
            ],
            ["execution-attestation.json", signedTrust.paths.attestationPath],
            ...(boundary
              ? [
                  [
                    "trust-data-boundary.json",
                    resolve(evidenceDirectory, "trust-data-boundary.json"),
                  ],
                  [
                    "static-provenance.json",
                    resolve(evidenceDirectory, "static-provenance.json"),
                  ],
                ]
              : []),
          ].map(
            async ([name, path]) =>
              [
                name as string,
                await readStableRegularFileSnapshot(
                  path as string,
                  MAX_EVIDENCE_BYTES,
                  "EFFECTS_AUDIT_INPUT_CHANGED",
                ),
              ] as const,
          ),
        ),
      )
    : undefined;
  const currentPolicySnapshot = signedTrust
    ? await readStableRegularFileSnapshot(
        signedTrust.currentPolicy.path,
        MAX_EVIDENCE_BYTES,
        "EFFECTS_AUDIT_INPUT_CHANGED",
      )
    : undefined;
  if (
    signedTrust &&
    signedInputSnapshots &&
    currentPolicySnapshot &&
    (signedInputSnapshots.get("requirements-approval.json")?.dev !==
      signedTrust.approval.fileIdentity.dev ||
      signedInputSnapshots.get("requirements-approval.json")?.ino !==
        signedTrust.approval.fileIdentity.ino ||
      signedInputSnapshots.get("issuance-trust-policy.json")?.dev !==
        signedTrust.issuancePolicy.fileIdentity.dev ||
      signedInputSnapshots.get("issuance-trust-policy.json")?.ino !==
        signedTrust.issuancePolicy.fileIdentity.ino ||
      signedInputSnapshots.get("execution-attestation.json")?.dev !==
        signedTrust.attestation.fileIdentity.dev ||
      signedInputSnapshots.get("execution-attestation.json")?.ino !==
        signedTrust.attestation.fileIdentity.ino ||
      currentPolicySnapshot.dev !==
        signedTrust.currentPolicy.fileIdentity.dev ||
      currentPolicySnapshot.ino !==
        signedTrust.currentPolicy.fileIdentity.ino ||
      sha256(
        signedInputSnapshots.get("requirements-approval.json")?.bytes ?? "",
      ) !== signedTrust.approval.sourceHash ||
      sha256(
        signedInputSnapshots.get("issuance-trust-policy.json")?.bytes ?? "",
      ) !== signedTrust.issuancePolicy.sourceHash ||
      sha256(
        signedInputSnapshots.get("execution-attestation.json")?.bytes ?? "",
      ) !== signedTrust.attestation.sourceHash ||
      (boundary &&
        (signedInputSnapshots.get("trust-data-boundary.json")?.dev !==
          boundary.fileIdentity.dev ||
          signedInputSnapshots.get("trust-data-boundary.json")?.ino !==
            boundary.fileIdentity.ino ||
          sha256(
            signedInputSnapshots.get("trust-data-boundary.json")?.bytes ?? "",
          ) !== boundary.sourceHash ||
          decodeUtf8(
            signedInputSnapshots.get("static-provenance.json")?.bytes ??
              new Uint8Array(),
            "static-provenance.json",
          ) !== `${stableJson(boundary.provenance)}\n`)) ||
      sha256(currentPolicySnapshot.bytes) !==
        signedTrust.currentPolicy.sourceHash)
  )
    throw new Error("EFFECTS_AUDIT_INPUT_CHANGED");
  const requirementComparisons: [unknown, unknown, string][] = [
    [intent.executionId, execution.executionId, "execution-id"],
    [
      intent.bundleIdentityHash,
      snapshot.bundleIdentityHash,
      "intent-bundle-identity",
    ],
    [
      intent.bundledWasmHash,
      sha256(snapshot.wasmBytes),
      "intent-bundled-wasm-hash",
    ],
    [intent.deadlineMs, reportGrantSummary.deadlineMs, "intent-deadline"],
    [intent.grantSourceHash, reportGrant.sourceHash, "grant-source-hash"],
    [
      intent.grantCommitmentHash,
      reportGrant.commitmentHash,
      "grant-commitment-hash",
    ],
    [
      fingerprintFor(intentGrantSummary),
      fingerprintFor(reportGrantSummary),
      "grant-summary",
    ],
    [intentRequirements.id, requirements.document.id, "requirements-id"],
    [
      intentRequirements.revision,
      requirements.document.revision,
      "requirements-revision",
    ],
    [
      intentRequirements.sourceHash,
      requirements.sourceHash,
      "requirements-source-hash",
    ],
    [
      intentRequirements.commitmentHash,
      requirements.commitmentHash,
      "requirements-commitment-hash",
    ],
    [
      intentRequirements.authorityCommitmentHash,
      requirements.authorityCommitmentHash,
      "authority-commitment-hash",
    ],
    [reportRequirements.id, requirements.document.id, "report-requirements-id"],
    [
      reportRequirements.revision,
      requirements.document.revision,
      "report-requirements-revision",
    ],
    [
      reportRequirements.sourceHash,
      requirements.sourceHash,
      "report-requirements-source-hash",
    ],
    [
      reportRequirements.commitmentHash,
      requirements.commitmentHash,
      "report-requirements-commitment-hash",
    ],
    [
      reportRequirements.authorityCommitmentHash,
      requirements.authorityCommitmentHash,
      "report-authority-commitment-hash",
    ],
    [
      reportAuthority.ceilingCommitmentHash,
      requirements.authorityCommitmentHash,
      "report-authority-ceiling-commitment-hash",
    ],
    [
      reportRequirements.bundleIdentityHash,
      snapshot.bundleIdentityHash,
      "report-requirements-bundle-identity",
    ],
    [
      reportBundle.bundleIdentityHash,
      snapshot.bundleIdentityHash,
      "bundle-identity",
    ],
    [
      reportBundle.bundledWasmHash,
      sha256(snapshot.wasmBytes),
      "report-bundled-wasm-hash",
    ],
  ];
  for (const [actual, expected, name] of requirementComparisons)
    if (actual !== expected) failures.push(name);
  if (
    !recovered &&
    fingerprintFor(reportRequirements.coverage as Record<string, unknown>) !==
      fingerprintFor(requirements.coverage)
  )
    failures.push("report-requirements-coverage");
  if (
    reportRequirements.status !== "bound" ||
    reportRequirements.semanticMeaning !== "not-proven" ||
    reportAuthority.grantWithinCeiling !== true ||
    !Array.isArray(reportAuthority.exceededRules) ||
    reportAuthority.exceededRules.length !== 0
  )
    failures.push("requirements-authority-report");
  const reportRuntime = object(execution.runtime)
    ? execution.runtime
    : undefined;
  if (
    (!recovered &&
      (reportBundle.entry !== snapshot.manifest.entry ||
        reportBundle.abi !== snapshot.manifest.abi ||
        reportBundle.manifestHash !== sha256(stableJson(snapshot.manifest)) ||
        reportBundle.inspectionVersion !== snapshot.inspection.version ||
        reportBundle.inspection !== "passed" ||
        !reportRuntime ||
        reportRuntime.bundledWasmHash !== sha256(snapshot.wasmBytes))) ||
    (recovered && !object(execution.recovery))
  )
    failures.push("execution-bundle-report");

  if (
    reportTranscript.format !== "llang-effects-transcript" ||
    reportTranscript.version !== 1 ||
    reportTranscript.path !== "effects-transcript.jsonl" ||
    reportTranscript.fileHash !== transcript.hash ||
    reportTranscript.finalHash !== transcript.finalHash ||
    reportTranscript.events !== transcript.events.length ||
    reportTranscript.bytes !== transcript.bytes ||
    (!recovered &&
      reportTranscript.firstHash !== (transcript.events[0]?.eventHash ?? null))
  )
    failures.push("transcript-identity");
  const intentHash = sha256(intentSnapshot.bytes),
    calculatedEvidenceHash = executionEvidenceHashFor(
      execution,
      intentHash,
      transcript.hash,
    );
  if (
    !HASH.test(String(reportAuthenticity.evidenceHash)) ||
    reportAuthenticity.evidenceHash !== calculatedEvidenceHash
  )
    failures.push("evidence-hash");
  if (
    reportAuthenticity.attestation !==
      (signed ? "detached-ed25519" : "not-signed") ||
    reportAuthenticity.retention !== "caller-managed"
  )
    failures.push("execution-authenticity-report");
  if (
    signed &&
    (!signedTrust ||
      reportAuthenticity.signerKeyId !== signedTrust.attestation.document.keyId)
  )
    failures.push("execution-attestation-report");
  if (
    reportCredential.values !== "not-recorded" ||
    !Array.isArray(reportCredential.headerNames) ||
    !Array.isArray(intent.credentialHeaderNames) ||
    !reportCredential.headerNames.every(
      (name) => typeof name === "string" && name === name.toLowerCase(),
    ) ||
    !intent.credentialHeaderNames.every(
      (name) => typeof name === "string" && name === name.toLowerCase(),
    ) ||
    fingerprintFor({ headers: reportCredential.headerNames }) !==
      fingerprintFor({ headers: intent.credentialHeaderNames }) ||
    reportCredential.status !==
      (intent.credentialInjection === "host-provided-not-recorded"
        ? "accessed"
        : "not-needed")
  )
    failures.push("credential-redaction-report");
  try {
    assertGrantSummaryWithinRequirement(reportGrantSummary, requirements);
  } catch {
    failures.push("grant-authority-ceiling");
  }
  if (
    reportRequirements.changedAfterStart === true ||
    reportBundle.bundleChangedAfterStart === true ||
    reportGrant.changedAfterStart === true
  )
    failures.push("execution-input-changed");
  if (
    !recovered &&
    (!reportTiming ||
      reportTiming.startedAt !== intent.startedAt ||
      !Number.isSafeInteger(reportTiming.startedAt) ||
      !Number.isSafeInteger(reportTiming.finishedAt) ||
      Number(reportTiming.finishedAt) < Number(reportTiming.startedAt) ||
      typeof reportTiming.durationMs !== "number" ||
      !Number.isFinite(reportTiming.durationMs) ||
      Number(reportTiming.durationMs) < 0 ||
      reportTiming.durationClock !== "monotonic")
  )
    failures.push("execution-timing-consistency");

  if (!recovered && reportResource) {
    const limits = reportResource.limits as Record<string, unknown>,
      used = reportResource.used as Record<string, unknown>,
      peak = reportResource.peak as Record<string, unknown>,
      unreleased = reportResource.unreleased as Record<string, unknown>,
      summaryLimits = reportGrantSummary.limits;
    if (
      !object(summaryLimits) ||
      fingerprintFor(limits) !== fingerprintFor(summaryLimits) ||
      LIMIT_NAMES.some(
        (name) =>
          Number(used[name]) > Number(peak[name]) ||
          Number(peak[name]) > Number(limits[name]),
      ) ||
      fingerprintFor(unreleased) !==
        fingerprintFor(
          Object.fromEntries(
            ["concurrentIo", "concurrentTasks", "openResources", "streams"]
              .filter((name) => Number(used[name]) !== 0)
              .map((name) => [name, used[name]]),
          ),
        ) ||
      reportResource.fuelUnit !== "continuation-yield" ||
      reportResource.memoryUnit !== "instantiated-wasm-byte"
    )
      failures.push("execution-resource-consistency");
  } else if (!recovered) failures.push("execution-resource-consistency");

  const observedRequests = transcript.events.filter(
      (event) => event.kind === "request",
    ),
    observedOperations = [
      ...new Set(
        observedRequests
          .map((event) => event.operation)
          .filter((operation): operation is string => !!operation),
      ),
    ].sort(),
    unboundObservedRequests = observedRequests.filter(
      (event) =>
        !requirements.document.bindings.some(
          (binding) =>
            (event.operation && binding.operations.includes(event.operation)) ||
            (event.state !== undefined && binding.nodes.includes(event.state)),
        ),
    ),
    unboundObservedOperations = [
      ...new Set(
        unboundObservedRequests
          .map((event) => event.operation)
          .filter((operation): operation is string => !!operation),
      ),
    ].sort(),
    grantOperations = Array.isArray(reportGrantSummary.operations)
      ? (reportGrantSummary.operations as unknown[]).filter(
          (operation): operation is string => typeof operation === "string",
        )
      : [],
    ungrantedObservedOperations = observedOperations.filter(
      (operation) => !grantOperations.includes(operation),
    );
  if (unboundObservedOperations.length)
    failures.push("unbound-observed-operation");
  if (ungrantedObservedOperations.length)
    failures.push("ungranted-observed-operation");

  const requestsById = new Map<
      string,
      Readonly<{ operation: string; state: number | undefined }>
    >(),
    respondedRequestIds = new Set<string>(),
    terminalEvents = transcript.events.filter(
      (event) => event.kind === "terminal",
    );
  let transcriptCorrelationFailed = false;
  for (const event of transcript.events) {
    if (event.kind === "request") {
      if (
        !event.requestId ||
        !event.operation ||
        requestsById.has(event.requestId)
      )
        transcriptCorrelationFailed = true;
      else
        requestsById.set(event.requestId, {
          operation: event.operation,
          state: event.state,
        });
      continue;
    }
    if (["response", "cleanup"].includes(event.kind)) {
      const request = event.requestId
        ? requestsById.get(event.requestId)
        : undefined;
      if (
        !request ||
        event.operation !== request.operation ||
        event.state !== request.state
      )
        transcriptCorrelationFailed = true;
      if (event.kind === "response" && event.requestId)
        respondedRequestIds.add(event.requestId);
    }
    if (event.kind === "stream-chunk") {
      const request = event.requestId
        ? requestsById.get(event.requestId)
        : undefined;
      if (!request || event.state !== request.state)
        transcriptCorrelationFailed = true;
    }
  }
  if (transcriptCorrelationFailed)
    failures.push("transcript-operation-correlation");

  const unknownOutcomes = transcript.events.filter(
    (event) => event.outcome?.certainty === "unknown",
  ).length;
  if (
    !recovered &&
    (reportCleanup?.attempted !== true ||
      !Array.isArray(reportCleanup.failures) ||
      !reportCleanup.failures.every((failure) => typeof failure === "string") ||
      reportCleanup.completed !== (reportCleanup.failures.length === 0) ||
      reportCleanup.unknownOutcomes !== unknownOutcomes)
  )
    failures.push("execution-cleanup-consistency");
  if (recovered) {
    const expectedPending = [...requestsById]
      .filter(([requestId]) => !respondedRequestIds.has(requestId))
      .map(([requestId, request]) => ({
        requestId,
        operation: request.operation,
        certainty: "unknown",
      }));
    if (
      reportRecovery?.replayedOperations !== 0 ||
      execution.status !== "incomplete" ||
      execution.incompleteReason !==
        (expectedPending.length
          ? "pending-requests"
          : "terminal-report-missing") ||
      fingerprintFor(reportResult.pendingRequests as object) !==
        fingerprintFor(expectedPending)
    )
      failures.push("execution-recovery-consistency");
  }

  const executionStatus = String(execution.status),
    allowedTerminal = requirements.document.expectedTerminalStatuses;
  if (!allowedTerminal.includes(executionStatus as never))
    failures.push("terminal-status");
  if (
    reportResult.status !== executionStatus ||
    terminalEvents.length > 1 ||
    (terminalEvents.length === 1 &&
      transcript.events.at(-1) !== terminalEvents[0]) ||
    (!recovered &&
      (terminalEvents.length !== 1 ||
        terminalEvents[0]?.outcome?.code !== executionStatus ||
        terminalEvents[0]?.outcome?.certainty !== reportResult.certainty))
  )
    failures.push("execution-terminal-consistency");
  if (
    (!recovered &&
      executionStatus === "completed" &&
      (!HASH.test(String(reportResult.resultHash)) ||
        fingerprintFor(reportResult.resultType as object) !==
          fingerprintFor(snapshot.manifest.resultType as object) ||
        !Number.isSafeInteger(reportResult.bytes) ||
        Number(reportResult.bytes) < 0 ||
        reportResult.certainty !== "known")) ||
    (!recovered &&
      executionStatus !== "completed" &&
      (typeof reportResult.errorCode !== "string" ||
        !["known", "unknown"].includes(String(reportResult.certainty)))) ||
    (recovered && reportResult.certainty !== "unknown")
  )
    failures.push("execution-result-consistency");

  const bindingById = new Map(
      requirements.document.bindings.map((binding) => [
        binding.requirementId,
        binding,
      ]),
    ),
    requirementResults = requirements.document.requirements.map(
      (requirement) => {
        const binding = bindingById.get(requirement.id),
          matchingEvents = binding
            ? transcript.events.filter(
                (event) =>
                  (event.operation &&
                    binding.operations.includes(event.operation)) ||
                  (event.state !== undefined &&
                    binding.nodes.includes(event.state)),
              )
            : [],
          count = (kind: (typeof transcript.events)[number]["kind"]) =>
            matchingEvents.filter((event) => event.kind === kind).length,
          outcomes = matchingEvents
            .map((event) => event.outcome)
            .filter((outcome) => outcome !== undefined),
          cleanupActions = [
            ...new Set(
              matchingEvents
                .map((event) => event.cleanupAction)
                .filter((action): action is NonNullable<typeof action> =>
                  Boolean(action),
                ),
            ),
          ].sort(),
          terminalMatches =
            !binding?.terminalStatuses.length ||
            binding.terminalStatuses.includes(executionStatus as never);
        if (!terminalMatches)
          failures.push(`requirement-terminal/${requirement.id}`);
        return Object.freeze({
          id: requirement.id,
          level: requirement.level,
          statement: requirement.statement,
          verification: requirement.verification,
          binding: binding ?? null,
          observations: {
            events: matchingEvents.length,
            requests: count("request"),
            responses: count("response"),
            streamChunks: count("stream-chunk"),
            cancellations: count("cancel"),
            cleanup: count("cleanup"),
            cleanupActions,
            outcomes: {
              known: outcomes.filter(
                (outcome) => outcome?.certainty === "known",
              ).length,
              unknown: outcomes.filter(
                (outcome) => outcome?.certainty === "unknown",
              ).length,
            },
            terminalStatus: binding?.terminalStatuses.length
              ? executionStatus
              : null,
            resourceAttribution: "execution-level-only",
          },
          status:
            requirement.verification === "manual"
              ? "not-machine-verified"
              : requirement.verification === "outcome"
                ? terminalMatches
                  ? "observed"
                  : "failed"
                : requirement.verification === "authority"
                  ? "enforced-before-dispatch"
                  : "structure-mapped",
        });
      },
    );
  if (
    signedTrust &&
    requirements.coverage.reviewRequired &&
    !signedTrust.currentPolicy.document.rules.allowReviewRequired
  )
    policyRejections.push("trust-policy-review-required");
  if (
    signedTrust &&
    recovered &&
    !signedTrust.currentPolicy.document.rules.allowRecoveredExecution
  )
    policyRejections.push("trust-policy-recovered-execution");
  const status = failures.length
      ? "failed"
      : requirements.coverage.reviewRequired
        ? "review-required"
        : "passed",
    base = {
      format: "llang-effects-execution-audit",
      version: 1,
      status,
      signatureStatus: signed ? "valid" : "missing",
      auditStatus: status,
      trustDecision: signedTrust
        ? failures.length || policyRejections.length
          ? "rejected"
          : "trusted"
        : "not-evaluated",
      requirements: {
        id: requirements.document.id,
        revision: requirements.document.revision,
        body: requirements.document.body,
        sourceHash: requirements.sourceHash,
        commitmentHash: requirements.commitmentHash,
        coverage: requirements.coverage,
        results: requirementResults,
      },
      bundle: {
        bundleIdentityHash: snapshot.bundleIdentityHash,
        entry: snapshot.manifest.entry,
        profile: snapshot.manifest.profile,
        abi: snapshot.manifest.abi,
        projectionHash: snapshot.inspection.typescript.projectionHash,
        bundledWasmHash: sha256(snapshot.wasmBytes),
      },
      authority: {
        ceilingCommitmentHash: requirements.authorityCommitmentHash,
        grantCommitmentHash: reportGrant.commitmentHash,
        grantWithinCeiling: !failures.includes("grant-authority-ceiling"),
      },
      execution: {
        executionId: execution.executionId,
        status: execution.status,
        result: reportResult,
        transcript: {
          events: transcript.events.length,
          bytes: transcript.bytes,
          fileHash: transcript.hash,
          finalHash: transcript.finalHash,
          observedOperations,
          unboundObservedRequests: unboundObservedRequests.length,
          unboundObservedOperations,
          ungrantedObservedOperations,
        },
        resource: execution.resource ?? null,
        cleanup: execution.cleanup ?? null,
        recovery: execution.recovery ?? null,
      },
      checks: {
        failures,
        policyRejections,
        machineChecks: failures.length ? "failed" : "passed",
        semanticMeaning: "not-proven",
        publisherAuthenticity: signed ? "trusted-key" : "not-proven",
        apiCalls: 0,
      },
      evidence: {
        intentHash,
        executionReportHash: sha256(executionSnapshot.bytes),
        executionEvidenceHash: reportAuthenticity.evidenceHash,
      },
      ...(boundary && observedFlow
        ? {
            trustData: {
              boundary: {
                id: boundary.document.id,
                revision: boundary.document.revision,
                sourceHash: boundary.sourceHash,
                commitmentHash: boundary.commitmentHash,
              },
              staticProvenanceHash: boundary.provenanceHash,
              observedFlowHash: fingerprintFor(observedFlow),
              authorityDerivation: "static-not-data-derived",
              staticFlowStatus: "passed",
              observedFlowStatus:
                reportTrustData?.observedFlowStatus === "incomplete"
                  ? "incomplete"
                  : "matched",
              rawExternalDataRecorded: false,
              sources: boundary.document.sources.map(({ id, operation }) => ({
                id,
                operation,
              })),
              sinks: boundary.document.sinks.map(({ id, operation }) => ({
                id,
                operation,
              })),
              allowedFlows: boundary.document.allowedFlows,
            },
          }
        : {}),
      trust: signedTrust
        ? {
            decision:
              failures.length || policyRejections.length
                ? "rejected"
                : "trusted",
            policy: {
              id: signedTrust.currentPolicy.document.id,
              revision: signedTrust.currentPolicy.document.revision,
              sourceHash: signedTrust.currentPolicy.sourceHash,
              commitmentHash: signedTrust.currentPolicy.commitmentHash,
            },
            issuancePolicy: {
              revision: signedTrust.issuancePolicy.document.revision,
              sourceHash: signedTrust.issuancePolicy.sourceHash,
              commitmentHash: signedTrust.issuancePolicy.commitmentHash,
            },
            requirementApprover: {
              keyId: signedTrust.approval.document.keyId,
              signature: "verified",
            },
            executionHost: {
              keyId: signedTrust.attestation.document.keyId,
              signature: "verified",
              phase: signedTrust.attestation.payload.phase,
            },
            signatureChecks: "verified",
          }
        : { decision: "not-evaluated" },
      authenticity: {
        attestation: "not-signed",
        retention: "caller-managed",
      },
      limitations: [
        "natural-language-requirement-meaning-not-proven",
        "requirement-binding-semantic-equivalence-not-proven",
        "host-and-publisher-authenticity-not-proven",
        "external-side-effects-not-rolled-back",
      ],
    },
    report = Object.freeze({
      ...base,
      authenticity: {
        ...base.authenticity,
        auditHash: fingerprintFor(base),
      },
    }) as EffectsExecutionAuditReport;

  await assertEffectsBundleIdentity(
    options.manifestPath,
    snapshot.bundleIdentityHash,
  );
  await assertEffectsRequirementIdentity(
    requirements,
    snapshot.bundleIdentityHash,
    snapshot.graph,
  );
  await Promise.all([
    assertInputSnapshot(intentPath, intentSnapshot),
    assertInputSnapshot(executionPath, executionSnapshot),
    assertInputSnapshot(transcriptPath, transcriptSnapshot),
    ...(signedTrust && signedInputSnapshots
      ? [
          assertInputSnapshot(
            signedTrust.paths.approvalPath,
            signedInputSnapshots.get("requirements-approval.json") as {
              dev: number;
              ino: number;
              bytes: Uint8Array;
            },
          ),
          assertInputSnapshot(
            signedTrust.paths.issuancePolicyPath,
            signedInputSnapshots.get("issuance-trust-policy.json") as {
              dev: number;
              ino: number;
              bytes: Uint8Array;
            },
          ),
          assertInputSnapshot(
            signedTrust.paths.attestationPath,
            signedInputSnapshots.get("execution-attestation.json") as {
              dev: number;
              ino: number;
              bytes: Uint8Array;
            },
          ),
        ]
      : []),
    ...(signedTrust && currentPolicySnapshot
      ? [
          assertInputSnapshot(
            signedTrust.currentPolicy.path,
            currentPolicySnapshot,
          ),
        ]
      : []),
  ]);
  const currentEvidence = await lstat(evidenceDirectory);
  if (
    currentEvidence.dev !== evidenceInfo.dev ||
    currentEvidence.ino !== evidenceInfo.ino ||
    !currentEvidence.isDirectory() ||
    currentEvidence.isSymbolicLink()
  )
    throw new Error("EFFECTS_AUDIT_INPUT_CHANGED");

  if (options.outputDirectory) {
    const output = await prepareAuditOutput(
        options.manifestPath,
        options.requirementsPath,
        evidenceDirectory,
        options.outputDirectory,
      ),
      projectionText = snapshot.inspection.typescript.source,
      transcriptText = decodeUtf8(transcriptSnapshot.bytes, transcriptPath),
      executionText = decodeUtf8(executionSnapshot.bytes, executionPath),
      reportText = `${stableJson(report)}\n`;
    try {
      await durableCreateText(
        resolve(output.path, "program.inspection.ts"),
        projectionText,
      );
      await durableCreateText(
        resolve(output.path, "effects-transcript.jsonl"),
        transcriptText,
      );
      await durableCreateText(
        resolve(output.path, "effects-execution.json"),
        executionText,
      );
      await durableCreateText(
        resolve(output.path, "execution-intent.json"),
        decodeUtf8(intentSnapshot.bytes, intentPath),
      );
      if (signedTrust && signedInputSnapshots)
        for (const [name, input] of [
          ["requirements-approval.json", signedTrust.paths.approvalPath],
          ["issuance-trust-policy.json", signedTrust.paths.issuancePolicyPath],
          ["execution-attestation.json", signedTrust.paths.attestationPath],
          ...(boundary
            ? [
                [
                  "trust-data-boundary.json",
                  resolve(evidenceDirectory, "trust-data-boundary.json"),
                ],
                [
                  "static-provenance.json",
                  resolve(evidenceDirectory, "static-provenance.json"),
                ],
              ]
            : []),
        ] as const) {
          const source = signedInputSnapshots.get(name);
          if (!source) throw new Error("EFFECTS_AUDIT_INPUT_CHANGED");
          await durableCreateText(
            resolve(output.path, name),
            decodeUtf8(source.bytes, input),
          );
        }
      await durableCreateText(
        resolve(output.path, "execution-audit.json"),
        reportText,
      );
      await assertDirectoryIdentity(output);
      await assertEffectsBundleIdentity(
        options.manifestPath,
        snapshot.bundleIdentityHash,
      );
      await assertEffectsRequirementIdentity(
        requirements,
        snapshot.bundleIdentityHash,
        snapshot.graph,
      );
      await Promise.all([
        assertInputSnapshot(intentPath, intentSnapshot),
        assertInputSnapshot(executionPath, executionSnapshot),
        assertInputSnapshot(transcriptPath, transcriptSnapshot),
      ]);
      for (const [name, expected] of [
        ["program.inspection.ts", projectionText],
        ["effects-transcript.jsonl", transcriptText],
        ["effects-execution.json", executionText],
        ["execution-intent.json", decodeUtf8(intentSnapshot.bytes, intentPath)],
        ["execution-audit.json", reportText],
      ] as const) {
        const published = await readStableRegularFileSnapshot(
          resolve(output.path, name),
          MAX_EVIDENCE_BYTES,
          "EFFECTS_AUDIT_OUTPUT_CHANGED",
        );
        if (decodeUtf8(published.bytes, name) !== expected)
          throw new Error("EFFECTS_AUDIT_OUTPUT_CHANGED");
      }
      if (signedInputSnapshots)
        for (const [name, expected] of signedInputSnapshots) {
          const published = await readStableRegularFileSnapshot(
            resolve(output.path, name),
            MAX_EVIDENCE_BYTES,
            "EFFECTS_AUDIT_OUTPUT_CHANGED",
          );
          if (sha256(published.bytes) !== sha256(expected.bytes))
            throw new Error("EFFECTS_AUDIT_OUTPUT_CHANGED");
        }
    } catch (error) {
      try {
        await assertDirectoryIdentity(output);
        await rm(output.path, { recursive: true });
      } catch {
        // A replaced directory is not owned and must not be removed.
      }
      throw error;
    }
  }
  return report;
}
