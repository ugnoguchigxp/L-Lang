import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertEffectsGrantSummaryShape } from "./llang-effects-requirement-contract";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";
import { readEffectsTranscript } from "./llang-effects-transcript-writer";
import {
  readStableRegularFile,
  readStableRegularFileSnapshot,
} from "./llang-effects-stable-file";
import {
  readEffectsSignatureEnvelope,
  readEffectsSigningKey,
  verifyEffectsAttestation,
} from "./llang-effects-attestation-crypto";
import {
  assertCurrentPolicyForIssuance,
  assertEffectsTrustRole,
  readEffectsTrustPolicy,
} from "./llang-effects-trust-policy";
import { createEffectsExecutionAttestation } from "./llang-effects-execution-attestation";
import {
  assertExecutionEvidenceShape,
  executionEvidenceHashFor,
} from "./llang-effects-execution-audit";
import { parseEffectsRequirementApprovalPayload } from "./llang-effects-requirement-approval";
import {
  effectsObservedFlowSummary,
  parseEffectsStaticProvenance,
  parseEffectsTrustBoundary,
  type ParsedEffectsTrustBoundary,
} from "./llang-effects-trust-boundary";

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const HEADER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

const regularBytes = (path: string, maximum = 16 * 1024 * 1024) =>
  readStableRegularFile(path, maximum, "INVALID_EXECUTION_EVIDENCE_FILE");

const jsonObject = (bytes: Uint8Array): Record<string, unknown> => {
  let value: unknown;
  try {
    value = parseStrictJsonObject(
      decodeUtf8(bytes, "execution evidence"),
      "execution evidence",
    );
  } catch {
    throw new Error("INVALID_EXECUTION_EVIDENCE_JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_EXECUTION_EVIDENCE_JSON");
  return value as Record<string, unknown>;
};

const processIsLive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
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

export async function recoverEffectsExecution(
  evidenceDirectory: string,
  options: { trustPolicyPath?: string; hostSigningKeyPath?: string } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const directory = resolve(evidenceDirectory),
    info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("INVALID_EXECUTION_EVIDENCE_DIRECTORY");
  const intentPath = resolve(directory, "execution-intent.json"),
    lockPath = resolve(directory, "execution.lock"),
    transcriptPath = resolve(directory, "effects-transcript.jsonl"),
    reportPath = resolve(directory, "effects-execution.json"),
    attestationPath = resolve(directory, "execution-attestation.json");
  let reportExists = false;
  try {
    await lstat(reportPath);
    reportExists = true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // The report does not exist, so recovery may continue.
    } else throw error;
  }
  const [intentSnapshot, lockSnapshot, transcript] = await Promise.all([
      readStableRegularFileSnapshot(
        intentPath,
        16 * 1024 * 1024,
        "INVALID_EXECUTION_EVIDENCE_FILE",
      ),
      readStableRegularFileSnapshot(
        lockPath,
        16 * 1024 * 1024,
        "INVALID_EXECUTION_EVIDENCE_FILE",
      ),
      readEffectsTranscript(transcriptPath),
    ]),
    intentBytes = intentSnapshot.bytes,
    lockBytes = lockSnapshot.bytes;
  const intent = jsonObject(intentBytes),
    lock = jsonObject(lockBytes),
    lockHash = sha256(lockBytes),
    intentVersion = intent.version,
    requirementBinding = object(intent.requirements)
      ? intent.requirements
      : undefined,
    intentKeys = [
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
      ...([2, 3, 4].includes(Number(intentVersion))
        ? ["grantSummary", "requirements"]
        : []),
      ...([3, 4].includes(Number(intentVersion)) ? ["attestation"] : []),
      ...(intentVersion === 4 ? ["boundary"] : []),
    ];
  if (
    !exact(intent, intentKeys) ||
    intent.format !== "llang-effects-execution-intent" ||
    ![1, 2, 3, 4].includes(Number(intentVersion)) ||
    typeof intent.executionId !== "string" ||
    !intent.executionId ||
    !HASH.test(String(intent.bundleIdentityHash)) ||
    !HASH.test(String(intent.grantSourceHash)) ||
    !HASH.test(String(intent.grantCommitmentHash)) ||
    !HASH.test(String(intent.bundledWasmHash)) ||
    typeof intent.startedAt !== "number" ||
    !Number.isFinite(intent.startedAt) ||
    intent.startedAt < 0 ||
    !Number.isSafeInteger(intent.deadlineMs) ||
    Number(intent.deadlineMs) < 1 ||
    Number(intent.deadlineMs) > 86_400_000 ||
    !["host-provided-not-recorded", "not-needed"].includes(
      String(intent.credentialInjection),
    ) ||
    !Array.isArray(intent.credentialHeaderNames) ||
    !intent.credentialHeaderNames.every(
      (item) =>
        typeof item === "string" &&
        item === item.toLowerCase() &&
        HEADER.test(item),
    ) ||
    intent.credentialHeaderNames.length !==
      new Set(intent.credentialHeaderNames).size ||
    intent.credentialHeaderNames.join("\0") !==
      [...intent.credentialHeaderNames].sort().join("\0") ||
    ([2, 3, 4].includes(Number(intentVersion)) &&
      (!object(intent.grantSummary) ||
        !requirementBinding ||
        !exact(requirementBinding, [
          "id",
          "revision",
          "sourceHash",
          "commitmentHash",
          "authorityCommitmentHash",
        ]) ||
        typeof requirementBinding.id !== "string" ||
        !ID.test(requirementBinding.id) ||
        !Number.isSafeInteger(requirementBinding.revision) ||
        Number(requirementBinding.revision) < 1 ||
        !HASH.test(String(requirementBinding.sourceHash)) ||
        !HASH.test(String(requirementBinding.commitmentHash)) ||
        !HASH.test(String(requirementBinding.authorityCommitmentHash)))) ||
    !exact(lock, [
      "format",
      "version",
      "executionId",
      "ownerToken",
      "pid",
      "startedAt",
    ]) ||
    lock.format !== "llang-effects-execution-lock" ||
    lock.version !== 1 ||
    lock.executionId !== intent.executionId ||
    typeof lock.ownerToken !== "string" ||
    !lock.ownerToken ||
    typeof lock.pid !== "number" ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid < 1 ||
    typeof lock.startedAt !== "number" ||
    !Number.isFinite(lock.startedAt)
  )
    throw new Error("INVALID_EXECUTION_EVIDENCE_OWNER");
  if ([2, 3, 4].includes(Number(intentVersion)))
    assertEffectsGrantSummaryShape(intent.grantSummary);
  if (reportExists && ![3, 4].includes(Number(intentVersion)))
    throw new Error("EXECUTION_REPORT_ALREADY_EXISTS");
  if (processIsLive(lock.pid)) throw new Error("EXECUTION_OWNER_IS_LIVE");

  const signed = [3, 4].includes(Number(intentVersion)),
    assured = intentVersion === 4;
  if (signed !== Boolean(options.trustPolicyPath && options.hostSigningKeyPath))
    throw new Error("SIGNED_RECOVERY_REQUIRES_TRUST_AND_HOST_KEY");
  const signedInputs = signed
    ? await (async () => {
        const issuance = await readEffectsTrustPolicy(
            resolve(directory, "issuance-trust-policy.json"),
          ),
          current = await readEffectsTrustPolicy(
            options.trustPolicyPath as string,
          ),
          signingKey = await readEffectsSigningKey(
            options.hostSigningKeyPath as string,
          ),
          approval = await readEffectsSignatureEnvelope(
            resolve(directory, "requirements-approval.json"),
            "requirement-approval",
          ),
          approvalPayload = parseEffectsRequirementApprovalPayload(
            approval.document.payload,
          ),
          binding = object(intent.attestation) ? intent.attestation : undefined,
          boundary = assured
            ? await (async (): Promise<ParsedEffectsTrustBoundary> => {
                const boundaryPath = resolve(
                    directory,
                    "trust-data-boundary.json",
                  ),
                  boundarySnapshot = await readStableRegularFileSnapshot(
                    boundaryPath,
                    1024 * 1024,
                    "INVALID_SIGNED_RECOVERY_BINDING",
                  ),
                  document = parseEffectsTrustBoundary(
                    jsonObject(boundarySnapshot.bytes),
                  ),
                  provenanceBytes = await regularBytes(
                    resolve(directory, "static-provenance.json"),
                  ),
                  provenance = parseEffectsStaticProvenance(
                    jsonObject(provenanceBytes),
                  ),
                  intentBoundary = object(intent.boundary)
                    ? intent.boundary
                    : undefined,
                  commitmentHash = fingerprintFor(document),
                  provenanceHash = fingerprintFor(provenance);
                if (
                  !intentBoundary ||
                  intentBoundary.id !== document.id ||
                  intentBoundary.revision !== document.revision ||
                  intentBoundary.sourceHash !==
                    sha256(boundarySnapshot.bytes) ||
                  intentBoundary.commitmentHash !== commitmentHash ||
                  intentBoundary.provenanceHash !== provenanceHash ||
                  approvalPayload.version !== 2 ||
                  approvalPayload.boundary?.commitmentHash !== commitmentHash ||
                  approvalPayload.boundary.provenanceHash !== provenanceHash
                )
                  throw new Error("INVALID_SIGNED_RECOVERY_BINDING");
                return Object.freeze({
                  path: boundaryPath,
                  fileIdentity: Object.freeze({
                    dev: boundarySnapshot.dev,
                    ino: boundarySnapshot.ino,
                  }),
                  sourceHash: sha256(boundarySnapshot.bytes),
                  commitmentHash,
                  document,
                  provenance,
                  provenanceHash,
                });
              })()
            : undefined;
        assertCurrentPolicyForIssuance(issuance, current);
        assertEffectsTrustRole(issuance, "executionHosts", signingKey.keyId);
        assertEffectsTrustRole(current, "executionHosts", signingKey.keyId);
        assertEffectsTrustRole(
          issuance,
          "requirementApprovers",
          approval.document.keyId,
        );
        assertEffectsTrustRole(
          current,
          "requirementApprovers",
          approval.document.keyId,
        );
        const approvalKey = issuance.publicKeys.get(approval.document.keyId);
        if (
          !approvalKey ||
          !verifyEffectsAttestation(approval.document, approvalKey) ||
          !binding ||
          binding.approvalSourceHash !== approval.sourceHash ||
          binding.approvalPayloadHash !== approval.document.payloadHash ||
          binding.approvalKeyId !== approval.document.keyId ||
          binding.issuancePolicyId !== issuance.document.id ||
          binding.issuancePolicyRevision !== issuance.document.revision ||
          binding.issuancePolicySourceHash !== issuance.sourceHash ||
          binding.issuancePolicyCommitmentHash !== issuance.commitmentHash ||
          binding.hostKeyId !== signingKey.keyId ||
          approvalPayload.bundle.bundleIdentityHash !==
            intent.bundleIdentityHash ||
          approvalPayload.bundle.bundledWasmHash !== intent.bundledWasmHash ||
          approvalPayload.requirements.id !== requirementBinding?.id ||
          approvalPayload.requirements.revision !==
            requirementBinding?.revision ||
          approvalPayload.requirements.sourceHash !==
            requirementBinding?.sourceHash ||
          approvalPayload.requirements.commitmentHash !==
            requirementBinding?.commitmentHash ||
          approvalPayload.requirements.authorityCommitmentHash !==
            requirementBinding?.authorityCommitmentHash ||
          (assured && !boundary)
        )
          throw new Error("INVALID_SIGNED_RECOVERY_BINDING");
        return {
          issuance,
          current,
          signingKey,
          approval,
          approvalPayload,
          boundary,
        };
      })()
    : undefined;
  const assertSignedRecoveryInputs = async () => {
    if (!signedInputs) return;
    const [
      issuance,
      current,
      approval,
      currentIntent,
      currentTranscript,
      currentBoundary,
      currentProvenance,
    ] = await Promise.all([
      readStableRegularFileSnapshot(
        signedInputs.issuance.path,
        1024 * 1024,
        "EXECUTION_EVIDENCE_FILE_CHANGED",
      ),
      readStableRegularFileSnapshot(
        signedInputs.current.path,
        1024 * 1024,
        "EXECUTION_EVIDENCE_FILE_CHANGED",
      ),
      readStableRegularFileSnapshot(
        signedInputs.approval.path,
        1024 * 1024,
        "EXECUTION_EVIDENCE_FILE_CHANGED",
      ),
      readStableRegularFileSnapshot(
        intentPath,
        16 * 1024 * 1024,
        "EXECUTION_EVIDENCE_FILE_CHANGED",
      ),
      readStableRegularFileSnapshot(
        transcriptPath,
        16 * 1024 * 1024,
        "EXECUTION_EVIDENCE_FILE_CHANGED",
      ),
      signedInputs.boundary
        ? readStableRegularFileSnapshot(
            signedInputs.boundary.path,
            1024 * 1024,
            "EXECUTION_EVIDENCE_FILE_CHANGED",
          )
        : undefined,
      signedInputs.boundary
        ? readStableRegularFileSnapshot(
            resolve(directory, "static-provenance.json"),
            1024 * 1024,
            "EXECUTION_EVIDENCE_FILE_CHANGED",
          )
        : undefined,
    ]);
    if (
      issuance.dev !== signedInputs.issuance.fileIdentity.dev ||
      issuance.ino !== signedInputs.issuance.fileIdentity.ino ||
      sha256(issuance.bytes) !== signedInputs.issuance.sourceHash ||
      current.dev !== signedInputs.current.fileIdentity.dev ||
      current.ino !== signedInputs.current.fileIdentity.ino ||
      sha256(current.bytes) !== signedInputs.current.sourceHash ||
      approval.dev !== signedInputs.approval.fileIdentity.dev ||
      approval.ino !== signedInputs.approval.fileIdentity.ino ||
      sha256(approval.bytes) !== signedInputs.approval.sourceHash ||
      currentIntent.dev !== intentSnapshot.dev ||
      currentIntent.ino !== intentSnapshot.ino ||
      sha256(currentIntent.bytes) !== sha256(intentBytes) ||
      currentTranscript.dev !== transcript.fileIdentity.dev ||
      currentTranscript.ino !== transcript.fileIdentity.ino ||
      sha256(currentTranscript.bytes) !== transcript.hash ||
      (signedInputs.boundary &&
        (!currentBoundary ||
          !currentProvenance ||
          currentBoundary.dev !== signedInputs.boundary.fileIdentity.dev ||
          currentBoundary.ino !== signedInputs.boundary.fileIdentity.ino ||
          sha256(currentBoundary.bytes) !== signedInputs.boundary.sourceHash ||
          fingerprintFor(
            parseEffectsStaticProvenance(jsonObject(currentProvenance.bytes)),
          ) !== signedInputs.boundary.provenanceHash))
    )
      throw new Error("EXECUTION_EVIDENCE_FILE_CHANGED");
  };
  await assertSignedRecoveryInputs();

  const pending = new Map<string, string>();
  for (const event of transcript.events) {
    if (event.kind === "request" && event.requestId)
      pending.set(event.requestId, event.operation ?? "unknown");
    if (event.kind === "response" && event.requestId)
      pending.delete(event.requestId);
  }
  const recoveredAt = Date.now(),
    base = {
      format: "llang-effects-execution",
      version: intentVersion,
      executionId: intent.executionId,
      status: "incomplete",
      recovered: true,
      incompleteReason: pending.size
        ? "pending-requests"
        : "terminal-report-missing",
      bundle: {
        bundleIdentityHash: intent.bundleIdentityHash,
        bundledWasmHash: intent.bundledWasmHash,
      },
      grant: {
        sourceHash: intent.grantSourceHash,
        commitmentHash: intent.grantCommitmentHash,
        ...([2, 3, 4].includes(Number(intentVersion))
          ? { summary: intent.grantSummary }
          : {}),
      },
      ...([2, 3, 4].includes(Number(intentVersion)) && requirementBinding
        ? {
            requirements: {
              status: "bound",
              id: requirementBinding.id,
              revision: requirementBinding.revision,
              sourceHash: requirementBinding.sourceHash,
              commitmentHash: requirementBinding.commitmentHash,
              authorityCommitmentHash:
                requirementBinding.authorityCommitmentHash,
              bundleIdentityHash: intent.bundleIdentityHash,
              semanticMeaning: "not-proven",
            },
            authority: {
              ceilingCommitmentHash: requirementBinding.authorityCommitmentHash,
              grantWithinCeiling: true,
              exceededRules: [],
            },
          }
        : {}),
      transcript: {
        format: "llang-effects-transcript",
        version: 1,
        path: "effects-transcript.jsonl",
        events: transcript.events.length,
        bytes: transcript.bytes,
        fileHash: transcript.hash,
        finalHash: transcript.finalHash,
      },
      result: {
        status: "incomplete",
        certainty: "unknown",
        pendingRequests: [...pending].map(([requestId, operation]) => ({
          requestId,
          operation,
          certainty: "unknown",
        })),
      },
      recovery: {
        staleOwner: {
          pid: lock.pid,
          ownerTokenHash: sha256(String(lock.ownerToken)),
          startedAt: lock.startedAt,
        },
        recoveredAt,
        replayedOperations: 0,
      },
      credential: {
        status:
          [2, 3, 4].includes(Number(intentVersion)) &&
          intent.credentialInjection === "host-provided-not-recorded"
            ? "accessed"
            : intent.credentialInjection,
        headerNames: intent.credentialHeaderNames,
        values: "not-recorded",
      },
      authenticity: {
        attestation: signed ? "detached-ed25519" : "not-signed",
        retention: "caller-managed",
        ...(signedInputs ? { signerKeyId: signedInputs.signingKey.keyId } : {}),
      },
      ...(signedInputs?.boundary
        ? (() => {
            const observedFlow = effectsObservedFlowSummary(
              signedInputs.boundary,
              transcript.events,
            );
            return {
              trustData: {
                boundary: {
                  id: signedInputs.boundary.document.id,
                  revision: signedInputs.boundary.document.revision,
                  sourceHash: signedInputs.boundary.sourceHash,
                  commitmentHash: signedInputs.boundary.commitmentHash,
                },
                staticProvenanceHash: signedInputs.boundary.provenanceHash,
                staticFlowStatus: "passed",
                observedFlowStatus: "incomplete",
                observedFlow,
                observedFlowHash: fingerprintFor(observedFlow),
                authorityDerivation: "static-not-data-derived",
                rawExternalDataRecorded: false,
              },
            };
          })()
        : {}),
      limitations: [
        "host-and-service-authenticity-not-proven",
        "business-correctness-not-proven",
        "external-side-effects-not-rolled-back",
      ],
    },
    evidenceHash = fingerprintFor({
      report: base,
      intentHash: sha256(intentBytes),
      transcriptHash: transcript.hash,
    }),
    recoveredReport = Object.freeze({
      ...base,
      authenticity: { ...base.authenticity, evidenceHash },
    }),
    report = reportExists
      ? jsonObject(await regularBytes(reportPath))
      : recoveredReport;
  const assertRecoveryOwnership = async () => {
    const currentDirectory = await lstat(directory),
      currentLock = await readStableRegularFileSnapshot(
        lockPath,
        16 * 1024 * 1024,
        "INVALID_EXECUTION_EVIDENCE_FILE",
      );
    if (
      !currentDirectory.isDirectory() ||
      currentDirectory.isSymbolicLink() ||
      currentDirectory.dev !== info.dev ||
      currentDirectory.ino !== info.ino ||
      currentLock.dev !== lockSnapshot.dev ||
      currentLock.ino !== lockSnapshot.ino ||
      sha256(currentLock.bytes) !== lockHash
    )
      throw new Error("EXECUTION_EVIDENCE_FILE_CHANGED");
  };
  await assertRecoveryOwnership();
  if (!reportExists)
    await durableCreateText(reportPath, `${stableJson(report)}\n`);
  await assertRecoveryOwnership();
  if (signedInputs) {
    const reportSnapshot = await readStableRegularFileSnapshot(
        reportPath,
        16 * 1024 * 1024,
        "INVALID_EXECUTION_EVIDENCE_FILE",
      ),
      reportBytes = reportSnapshot.bytes,
      reportDocument = jsonObject(reportBytes),
      reportAuthenticity = object(reportDocument.authenticity)
        ? reportDocument.authenticity
        : undefined,
      reportResult = object(reportDocument.result)
        ? reportDocument.result
        : undefined,
      reportTranscript = object(reportDocument.transcript)
        ? reportDocument.transcript
        : undefined,
      reportBundle = object(reportDocument.bundle)
        ? reportDocument.bundle
        : undefined,
      reportGrant = object(reportDocument.grant)
        ? reportDocument.grant
        : undefined,
      reportRequirements = object(reportDocument.requirements)
        ? reportDocument.requirements
        : undefined;
    assertExecutionEvidenceShape(intent, reportDocument);
    if (
      reportDocument.version !== intentVersion ||
      reportDocument.executionId !== intent.executionId ||
      !reportAuthenticity ||
      !reportResult ||
      !reportTranscript ||
      !reportBundle ||
      !reportGrant ||
      !reportRequirements ||
      !object(reportGrant.summary) ||
      !object(intent.grantSummary) ||
      reportBundle.bundleIdentityHash !== intent.bundleIdentityHash ||
      reportBundle.bundledWasmHash !== intent.bundledWasmHash ||
      reportGrant.sourceHash !== intent.grantSourceHash ||
      reportGrant.commitmentHash !== intent.grantCommitmentHash ||
      fingerprintFor(reportGrant.summary as object) !==
        fingerprintFor(intent.grantSummary as object) ||
      reportRequirements.id !== requirementBinding?.id ||
      reportRequirements.revision !== requirementBinding?.revision ||
      reportRequirements.sourceHash !== requirementBinding?.sourceHash ||
      reportRequirements.commitmentHash !==
        requirementBinding?.commitmentHash ||
      reportRequirements.authorityCommitmentHash !==
        requirementBinding?.authorityCommitmentHash ||
      reportTranscript.fileHash !== transcript.hash ||
      reportTranscript.finalHash !== transcript.finalHash ||
      reportTranscript.events !== transcript.events.length ||
      reportTranscript.bytes !== transcript.bytes ||
      reportResult.status !== reportDocument.status ||
      reportAuthenticity.attestation !== "detached-ed25519" ||
      reportAuthenticity.retention !== "caller-managed" ||
      reportAuthenticity.signerKeyId !== signedInputs.signingKey.keyId ||
      reportAuthenticity.evidenceHash !==
        executionEvidenceHashFor(
          reportDocument,
          sha256(intentBytes),
          transcript.hash,
        )
    )
      throw new Error("INVALID_SIGNED_RECOVERY_REPORT");
    const recoveryPhase =
      reportDocument.recovered === true
        ? "recovery-incomplete"
        : reportExists
          ? "recovery-after-report"
          : "recovery-incomplete";
    const attestation = createEffectsExecutionAttestation(
      {
        format: "llang-effects-execution-attestation",
        version: signedInputs.boundary ? 2 : 1,
        executionId: String(intent.executionId),
        phase: recoveryPhase,
        approval: {
          sourceHash: signedInputs.approval.sourceHash,
          payloadHash: signedInputs.approval.document.payloadHash,
          keyId: signedInputs.approval.document.keyId,
        },
        issuancePolicy: {
          id: signedInputs.issuance.document.id,
          revision: signedInputs.issuance.document.revision,
          sourceHash: signedInputs.issuance.sourceHash,
          commitmentHash: signedInputs.issuance.commitmentHash,
        },
        intentHash: sha256(intentBytes),
        bundle: {
          bundleIdentityHash: String(intent.bundleIdentityHash),
          bundledWasmHash: String(intent.bundledWasmHash),
        },
        requirements: {
          sourceHash: String(requirementBinding?.sourceHash),
          commitmentHash: String(requirementBinding?.commitmentHash),
          authorityCommitmentHash: String(
            requirementBinding?.authorityCommitmentHash,
          ),
        },
        grant: {
          sourceHash: String(intent.grantSourceHash),
          commitmentHash: String(intent.grantCommitmentHash),
        },
        transcript: {
          fileHash: String(reportTranscript.fileHash),
          finalHash: String(reportTranscript.finalHash),
          events: Number(reportTranscript.events),
        },
        execution: {
          reportHash: sha256(reportBytes),
          evidenceHash: String(reportAuthenticity.evidenceHash),
          status: reportDocument.status as
            | "completed"
            | "failed"
            | "cancelled"
            | "incomplete",
          certainty: reportResult.certainty as "known" | "unknown",
          cleanupCommitmentHash: fingerprintFor(
            (reportDocument.cleanup ?? {}) as object,
          ),
          resourceCommitmentHash: fingerprintFor(
            (reportDocument.resource ?? {}) as object,
          ),
          replayedOperations: object(reportDocument.recovery)
            ? Number(reportDocument.recovery.replayedOperations)
            : 0,
        },
        ...(signedInputs.boundary && object(reportDocument.trustData)
          ? {
              boundary: {
                sourceHash: signedInputs.boundary.sourceHash,
                commitmentHash: signedInputs.boundary.commitmentHash,
                provenanceHash: signedInputs.boundary.provenanceHash,
                observedFlowHash: String(
                  reportDocument.trustData.observedFlowHash,
                ),
              },
            }
          : {}),
      },
      signedInputs.signingKey,
    );
    await assertSignedRecoveryInputs();
    const attestationText = `${stableJson(attestation)}\n`;
    await durableCreateText(attestationPath, attestationText);
    const [publishedAttestation, currentReport] = await Promise.all([
      readEffectsSignatureEnvelope(attestationPath, "execution-attestation"),
      readStableRegularFileSnapshot(
        reportPath,
        16 * 1024 * 1024,
        "EXECUTION_EVIDENCE_FILE_CHANGED",
      ),
    ]);
    if (
      publishedAttestation.sourceHash !== sha256(attestationText) ||
      currentReport.dev !== reportSnapshot.dev ||
      currentReport.ino !== reportSnapshot.ino ||
      sha256(currentReport.bytes) !== sha256(reportBytes)
    )
      throw new Error("EXECUTION_EVIDENCE_FILE_CHANGED");
  }
  if (sha256(await regularBytes(lockPath)) !== lockHash)
    throw new Error("EXECUTION_EVIDENCE_FILE_CHANGED");
  await unlink(lockPath);
  return report;
}
