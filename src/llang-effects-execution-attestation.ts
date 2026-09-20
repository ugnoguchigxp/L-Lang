import {
  readEffectsSignatureEnvelope,
  signEffectsAttestation,
  verifyEffectsAttestation,
  type EffectsSignatureEnvelope,
  type EffectsSigningKey,
} from "./llang-effects-attestation-crypto";
import {
  assertEffectsTrustRole,
  type ParsedEffectsTrustPolicy,
} from "./llang-effects-trust-policy";

const HASH = /^[0-9a-f]{64}$/;
const KEY_ID = /^ed25519:[0-9a-f]{64}$/;
const PHASES = [
  "normal",
  "recovery-incomplete",
  "recovery-after-report",
] as const;
const STATUSES = ["completed", "failed", "cancelled", "incomplete"] as const;
const CERTAINTIES = ["known", "unknown"] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

export type EffectsExecutionAttestationPhase = (typeof PHASES)[number];
export type EffectsExecutionAttestationPayload = Readonly<{
  format: "llang-effects-execution-attestation";
  version: 1 | 2;
  executionId: string;
  phase: EffectsExecutionAttestationPhase;
  approval: Readonly<{
    sourceHash: string;
    payloadHash: string;
    keyId: string;
  }>;
  issuancePolicy: Readonly<{
    id: string;
    revision: number;
    sourceHash: string;
    commitmentHash: string;
  }>;
  intentHash: string;
  bundle: Readonly<{
    bundleIdentityHash: string;
    bundledWasmHash: string;
  }>;
  requirements: Readonly<{
    sourceHash: string;
    commitmentHash: string;
    authorityCommitmentHash: string;
  }>;
  grant: Readonly<{
    sourceHash: string;
    commitmentHash: string;
  }>;
  transcript: Readonly<{
    fileHash: string;
    finalHash: string;
    events: number;
  }>;
  execution: Readonly<{
    reportHash: string;
    evidenceHash: string;
    status: (typeof STATUSES)[number];
    certainty: (typeof CERTAINTIES)[number];
    cleanupCommitmentHash: string;
    resourceCommitmentHash: string;
    replayedOperations: number;
  }>;
  boundary?: Readonly<{
    sourceHash: string;
    commitmentHash: string;
    provenanceHash: string;
    observedFlowHash: string;
  }>;
}>;

function hashObject(value: unknown): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.values(value).every((item) => typeof item !== "undefined")
  );
}

export function parseEffectsExecutionAttestationPayload(
  value: Readonly<Record<string, unknown>>,
): EffectsExecutionAttestationPayload {
  if (
    !exact(
      value,
      value.version === 2
        ? [
            "format",
            "version",
            "executionId",
            "phase",
            "approval",
            "issuancePolicy",
            "intentHash",
            "bundle",
            "requirements",
            "grant",
            "transcript",
            "execution",
            "boundary",
          ]
        : [
            "format",
            "version",
            "executionId",
            "phase",
            "approval",
            "issuancePolicy",
            "intentHash",
            "bundle",
            "requirements",
            "grant",
            "transcript",
            "execution",
          ],
    ) ||
    value.format !== "llang-effects-execution-attestation" ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.executionId !== "string" ||
    !value.executionId ||
    !PHASES.includes(value.phase as EffectsExecutionAttestationPhase) ||
    !HASH.test(String(value.intentHash)) ||
    !object(value.approval) ||
    !exact(value.approval, ["sourceHash", "payloadHash", "keyId"]) ||
    !HASH.test(String(value.approval.sourceHash)) ||
    !HASH.test(String(value.approval.payloadHash)) ||
    !KEY_ID.test(String(value.approval.keyId)) ||
    !object(value.issuancePolicy) ||
    !exact(value.issuancePolicy, [
      "id",
      "revision",
      "sourceHash",
      "commitmentHash",
    ]) ||
    typeof value.issuancePolicy.id !== "string" ||
    !Number.isSafeInteger(value.issuancePolicy.revision) ||
    !HASH.test(String(value.issuancePolicy.sourceHash)) ||
    !HASH.test(String(value.issuancePolicy.commitmentHash)) ||
    !hashObject(value.bundle) ||
    !exact(value.bundle, ["bundleIdentityHash", "bundledWasmHash"]) ||
    !Object.values(value.bundle).every((item) => HASH.test(String(item))) ||
    !hashObject(value.requirements) ||
    !exact(value.requirements, [
      "sourceHash",
      "commitmentHash",
      "authorityCommitmentHash",
    ]) ||
    !Object.values(value.requirements).every((item) =>
      HASH.test(String(item)),
    ) ||
    !hashObject(value.grant) ||
    !exact(value.grant, ["sourceHash", "commitmentHash"]) ||
    !Object.values(value.grant).every((item) => HASH.test(String(item))) ||
    !object(value.transcript) ||
    !exact(value.transcript, ["fileHash", "finalHash", "events"]) ||
    !HASH.test(String(value.transcript.fileHash)) ||
    !HASH.test(String(value.transcript.finalHash)) ||
    !Number.isSafeInteger(value.transcript.events) ||
    Number(value.transcript.events) < 0 ||
    !object(value.execution) ||
    !exact(value.execution, [
      "reportHash",
      "evidenceHash",
      "status",
      "certainty",
      "cleanupCommitmentHash",
      "resourceCommitmentHash",
      "replayedOperations",
    ]) ||
    !HASH.test(String(value.execution.reportHash)) ||
    !HASH.test(String(value.execution.evidenceHash)) ||
    !STATUSES.includes(value.execution.status as (typeof STATUSES)[number]) ||
    !CERTAINTIES.includes(
      value.execution.certainty as (typeof CERTAINTIES)[number],
    ) ||
    !HASH.test(String(value.execution.cleanupCommitmentHash)) ||
    !HASH.test(String(value.execution.resourceCommitmentHash)) ||
    !Number.isSafeInteger(value.execution.replayedOperations) ||
    Number(value.execution.replayedOperations) < 0 ||
    (value.version === 2 &&
      (!object(value.boundary) ||
        !exact(value.boundary, [
          "sourceHash",
          "commitmentHash",
          "provenanceHash",
          "observedFlowHash",
        ]) ||
        Object.values(value.boundary).some(
          (item) => typeof item !== "string" || !HASH.test(item),
        )))
  )
    throw new Error("INVALID_EFFECTS_EXECUTION_ATTESTATION");
  return value as EffectsExecutionAttestationPayload;
}

export function createEffectsExecutionAttestation(
  payload: EffectsExecutionAttestationPayload,
  signingKey: EffectsSigningKey,
): EffectsSignatureEnvelope {
  parseEffectsExecutionAttestationPayload(payload);
  return signEffectsAttestation("execution-attestation", payload, signingKey);
}

export async function readAndVerifyEffectsExecutionAttestation(options: {
  path: string;
  policy: ParsedEffectsTrustPolicy;
}) {
  const parsed = await readEffectsSignatureEnvelope(
      options.path,
      "execution-attestation",
    ),
    payload = parseEffectsExecutionAttestationPayload(parsed.document.payload);
  assertEffectsTrustRole(
    options.policy,
    "executionHosts",
    parsed.document.keyId,
  );
  const publicKey = options.policy.publicKeys.get(parsed.document.keyId);
  if (!publicKey || !verifyEffectsAttestation(parsed.document, publicKey))
    throw new Error("INVALID_EFFECTS_EXECUTION_ATTESTATION_SIGNATURE");
  return Object.freeze({ ...parsed, payload });
}
