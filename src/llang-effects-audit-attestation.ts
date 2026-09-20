import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  readEffectsSignatureEnvelope,
  readEffectsSigningKey,
  signEffectsAttestation,
  verifyEffectsAttestation,
} from "./llang-effects-attestation-crypto";
import { auditEffectsExecution } from "./llang-effects-execution-audit";
import { pathsOverlap } from "./llang-effects-execution-grant";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";
import {
  assertEffectsTrustRole,
  readEffectsTrustPolicy,
  type ParsedEffectsTrustPolicy,
} from "./llang-effects-trust-policy";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";

const MAX_BYTES = 16 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const KEY_ID = /^ed25519:[0-9a-f]{64}$/;
const BASE_FILES = [
  "program.inspection.ts",
  "effects-transcript.jsonl",
  "effects-execution.json",
  "execution-intent.json",
  "requirements-approval.json",
  "issuance-trust-policy.json",
  "execution-attestation.json",
  "execution-audit.json",
] as const;
const ASSURED_FILES = [
  ...BASE_FILES,
  "trust-data-boundary.json",
  "static-provenance.json",
] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

async function assertExactFiles(
  directory: string,
  expected: readonly string[],
) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    entries
      .map((entry) => entry.name)
      .sort()
      .join("\0") !== [...expected].sort().join("\0")
  )
    throw new Error("INVALID_EFFECTS_ATTESTATION_PACKAGE_FILES");
}

type AuditAttestationPayload = Readonly<{
  format: "llang-effects-audit-attestation";
  version: 1 | 2;
  policy: Readonly<{
    id: string;
    revision: number;
    commitmentHash: string;
  }>;
  audit: Readonly<{
    auditHash: string;
    status: string;
    trustDecision: string;
    requirementApproverKeyId: string;
    executionHostKeyId: string;
  }>;
  commitments: Readonly<{
    requirements: string;
    bundle: string;
    grant: string;
    intent: string;
    executionReport: string;
    executionEvidence: string;
  }>;
  files: Readonly<Record<string, string>>;
  boundary?: Readonly<{
    commitmentHash: string;
    provenanceHash: string;
    observedFlowHash: string;
  }>;
}>;

function parsePayload(value: Record<string, unknown>): AuditAttestationPayload {
  if (
    !exact(
      value,
      value.version === 2
        ? [
            "format",
            "version",
            "policy",
            "audit",
            "commitments",
            "files",
            "boundary",
          ]
        : ["format", "version", "policy", "audit", "commitments", "files"],
    ) ||
    value.format !== "llang-effects-audit-attestation" ||
    (value.version !== 1 && value.version !== 2) ||
    !object(value.policy) ||
    !exact(value.policy, ["id", "revision", "commitmentHash"]) ||
    typeof value.policy.id !== "string" ||
    !value.policy.id ||
    !Number.isSafeInteger(value.policy.revision) ||
    Number(value.policy.revision) < 1 ||
    !HASH.test(String(value.policy.commitmentHash)) ||
    !object(value.audit) ||
    !exact(value.audit, [
      "auditHash",
      "status",
      "trustDecision",
      "requirementApproverKeyId",
      "executionHostKeyId",
    ]) ||
    !HASH.test(String(value.audit.auditHash)) ||
    !["passed", "review-required", "failed"].includes(
      String(value.audit.status),
    ) ||
    !["trusted", "rejected"].includes(String(value.audit.trustDecision)) ||
    !KEY_ID.test(String(value.audit.requirementApproverKeyId)) ||
    !KEY_ID.test(String(value.audit.executionHostKeyId)) ||
    !object(value.commitments) ||
    !exact(value.commitments, [
      "requirements",
      "bundle",
      "grant",
      "intent",
      "executionReport",
      "executionEvidence",
    ]) ||
    Object.values(value.commitments).some(
      (hash) => typeof hash !== "string" || !HASH.test(hash),
    ) ||
    !object(value.files) ||
    (!exact(value.files, BASE_FILES) && !exact(value.files, ASSURED_FILES)) ||
    Object.values(value.files).some(
      (hash) => typeof hash !== "string" || !HASH.test(hash),
    ) ||
    (value.version === 2 &&
      (!object(value.boundary) ||
        !exact(value.boundary, [
          "commitmentHash",
          "provenanceHash",
          "observedFlowHash",
        ]) ||
        Object.values(value.boundary).some(
          (hash) => typeof hash !== "string" || !HASH.test(hash),
        )))
  )
    throw new Error("INVALID_EFFECTS_AUDIT_ATTESTATION");
  return value as AuditAttestationPayload;
}

async function durableCreateText(path: string, value: string) {
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

async function readFiles(directory: string, names: readonly string[]) {
  return new Map(
    await Promise.all(
      names.map(async (name) => {
        const snapshot = await readStableRegularFileSnapshot(
          resolve(directory, name),
          MAX_BYTES,
          "INVALID_EFFECTS_ATTESTATION_PACKAGE",
        );
        return [name, snapshot] as const;
      }),
    ),
  );
}

function payloadFor(
  files: Awaited<ReturnType<typeof readFiles>>,
  audit: Record<string, unknown>,
  policy: Readonly<{ id: string; revision: number; commitmentHash: string }>,
): AuditAttestationPayload {
  const trust = audit.trust;
  if (!object(trust)) throw new Error("INVALID_EFFECTS_EXECUTION_AUDIT");
  const authenticity = audit.authenticity;
  if (!object(authenticity) || !HASH.test(String(authenticity.auditHash)))
    throw new Error("INVALID_EFFECTS_EXECUTION_AUDIT");
  const requirements = audit.requirements,
    bundle = audit.bundle,
    authority = audit.authority,
    evidence = audit.evidence;
  if (
    !object(requirements) ||
    !object(bundle) ||
    !object(authority) ||
    !object(evidence)
  )
    throw new Error("INVALID_EFFECTS_EXECUTION_AUDIT");
  const requirementApprover = trust.requirementApprover,
    executionHost = trust.executionHost,
    trustData = audit.trustData;
  if (!object(requirementApprover) || !object(executionHost))
    throw new Error("INVALID_EFFECTS_EXECUTION_AUDIT");
  return Object.freeze({
    format: "llang-effects-audit-attestation",
    version: object(trustData) ? 2 : 1,
    policy: Object.freeze({
      id: policy.id,
      revision: policy.revision,
      commitmentHash: policy.commitmentHash,
    }),
    audit: Object.freeze({
      auditHash: String(authenticity.auditHash),
      status: String(audit.status),
      trustDecision: String(trust.decision),
      requirementApproverKeyId: String(requirementApprover.keyId),
      executionHostKeyId: String(executionHost.keyId),
    }),
    commitments: Object.freeze({
      requirements: String(requirements.commitmentHash),
      bundle: String(bundle.bundleIdentityHash),
      grant: String(authority.grantCommitmentHash),
      intent: String(evidence.intentHash),
      executionReport: String(evidence.executionReportHash),
      executionEvidence: String(evidence.executionEvidenceHash),
    }),
    files: Object.freeze(
      Object.fromEntries(
        [...files.entries()].map(([name, file]) => [name, sha256(file.bytes)]),
      ),
    ),
    ...(object(trustData)
      ? {
          boundary: Object.freeze({
            commitmentHash: String(
              object(trustData.boundary)
                ? trustData.boundary.commitmentHash
                : "",
            ),
            provenanceHash: String(trustData.staticProvenanceHash),
            observedFlowHash: String(trustData.observedFlowHash),
          }),
        }
      : {}),
  });
}

function auditWithoutCurrentPolicy(value: Record<string, unknown>) {
  const checks = object(value.checks) ? { ...value.checks } : value.checks;
  if (object(checks)) delete checks.policyRejections;
  const comparable: Record<string, unknown> = { ...value, checks };
  delete comparable.trust;
  delete comparable.trustDecision;
  delete comparable.authenticity;
  return comparable;
}

function assertReportPolicyMatches(
  report: Record<string, unknown>,
  policy: ParsedEffectsTrustPolicy,
) {
  const trust = report.trust,
    reportPolicy = object(trust) ? trust.policy : undefined;
  if (
    !object(reportPolicy) ||
    reportPolicy.id !== policy.document.id ||
    reportPolicy.revision !== policy.document.revision ||
    reportPolicy.sourceHash !== policy.sourceHash ||
    reportPolicy.commitmentHash !== policy.commitmentHash
  )
    throw new Error("EFFECTS_ATTESTATION_POLICY_CHANGED");
}

async function assertPolicyUnchanged(policy: ParsedEffectsTrustPolicy) {
  const current = await readStableRegularFileSnapshot(
    policy.path,
    MAX_BYTES,
    "EFFECTS_ATTESTATION_POLICY_CHANGED",
  );
  if (
    current.dev !== policy.fileIdentity.dev ||
    current.ino !== policy.fileIdentity.ino ||
    sha256(current.bytes) !== policy.sourceHash
  )
    throw new Error("EFFECTS_ATTESTATION_POLICY_CHANGED");
}

async function verifiedAudit(options: {
  manifestPath: string;
  requirementsPath: string;
  directory: string;
  trustPolicyPath: string;
  allowPolicyAdvance?: boolean;
}) {
  const report = await auditEffectsExecution({
      manifestPath: options.manifestPath,
      requirementsPath: options.requirementsPath,
      evidenceDirectory: options.directory,
      trustPolicyPath: options.trustPolicyPath,
      requireAttestation: true,
    }),
    auditPath = resolve(options.directory, "execution-audit.json"),
    auditSnapshot = await readStableRegularFileSnapshot(
      auditPath,
      MAX_BYTES,
      "INVALID_EFFECTS_EXECUTION_AUDIT",
    ),
    stored = parseStrictJsonObject(
      decodeUtf8(auditSnapshot.bytes, auditPath),
      auditPath,
    );
  if (
    !object(stored) ||
    (options.allowPolicyAdvance
      ? fingerprintFor(auditWithoutCurrentPolicy(stored)) !==
        fingerprintFor(auditWithoutCurrentPolicy(report))
      : fingerprintFor(stored) !== fingerprintFor(report))
  )
    throw new Error("EFFECTS_EXECUTION_AUDIT_NOT_ATTESTABLE");
  return { report, storedReport: stored, auditSnapshot };
}

export async function attestEffectsAudit(options: {
  manifestPath: string;
  requirementsPath: string;
  auditDirectory: string;
  trustPolicyPath: string;
  signingKeyPath: string;
  outputDirectory: string;
}) {
  const auditInput = resolve(options.auditDirectory),
    auditInfo = await lstat(auditInput);
  if (!auditInfo.isDirectory() || auditInfo.isSymbolicLink())
    throw new Error("INVALID_EFFECTS_AUDIT_DIRECTORY");
  const auditDirectory = await realpath(auditInput),
    auditDirectoryInfo = await lstat(auditDirectory),
    policy = await readEffectsTrustPolicy(options.trustPolicyPath),
    signingKey = await readEffectsSigningKey(options.signingKeyPath);
  if (
    auditDirectoryInfo.dev !== auditInfo.dev ||
    auditDirectoryInfo.ino !== auditInfo.ino
  )
    throw new Error("INVALID_EFFECTS_AUDIT_DIRECTORY");
  const executionSnapshot = await readStableRegularFileSnapshot(
      resolve(auditDirectory, "effects-execution.json"),
      MAX_BYTES,
      "INVALID_EFFECTS_ATTESTATION_PACKAGE",
    ),
    execution = parseStrictJsonObject(
      decodeUtf8(executionSnapshot.bytes, "effects-execution.json"),
      "effects-execution.json",
    );
  if (!object(execution))
    throw new Error("INVALID_EFFECTS_ATTESTATION_PACKAGE");
  const fileNames = execution.version === 4 ? ASSURED_FILES : BASE_FILES;
  await assertExactFiles(auditDirectory, fileNames);
  assertEffectsTrustRole(policy, "auditors", signingKey.keyId);
  const { report } = await verifiedAudit({
      manifestPath: options.manifestPath,
      requirementsPath: options.requirementsPath,
      directory: auditDirectory,
      trustPolicyPath: options.trustPolicyPath,
    }),
    files = await readFiles(auditDirectory, fileNames),
    targetInput = resolve(options.outputDirectory),
    parentInfo = await lstat(dirname(targetInput)),
    parent = await realpath(dirname(targetInput)),
    target = resolve(parent, basename(targetInput));
  assertReportPolicyMatches(report, policy);
  await assertPolicyUnchanged(policy);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new Error("INVALID_ATTESTATION_PACKAGE_PARENT");
  if (
    pathsOverlap(auditDirectory, target) ||
    pathsOverlap(await realpath(resolve(options.manifestPath)), target) ||
    pathsOverlap(await realpath(resolve(options.requirementsPath)), target) ||
    pathsOverlap(await realpath(resolve(options.trustPolicyPath)), target) ||
    pathsOverlap(await realpath(resolve(options.signingKeyPath)), target)
  )
    throw new Error("ATTESTATION_PACKAGE_OVERLAPS_AUDIT");
  const auditFile = files.get("execution-audit.json"),
    copiedAudit = auditFile
      ? parseStrictJsonObject(
          decodeUtf8(auditFile.bytes, "execution-audit.json"),
          "execution-audit.json",
        )
      : undefined;
  if (
    !auditFile ||
    !object(copiedAudit) ||
    fingerprintFor(copiedAudit) !== fingerprintFor(report)
  )
    throw new Error("EFFECTS_AUDIT_INPUT_CHANGED");
  await mkdir(target);
  const outputInfo = await lstat(target),
    assertOutput = async () => {
      const current = await lstat(target);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== outputInfo.dev ||
        current.ino !== outputInfo.ino
      )
        throw new Error("EFFECTS_ATTESTATION_PACKAGE_CHANGED");
    };
  try {
    for (const name of fileNames) {
      await assertOutput();
      const snapshot = files.get(name);
      if (!snapshot) throw new Error("INVALID_EFFECTS_ATTESTATION_PACKAGE");
      await durableCreateText(
        resolve(target, name),
        decodeUtf8(snapshot.bytes, resolve(auditDirectory, name)),
      );
    }
    await assertOutput();
    const payload = parsePayload(
        payloadFor(files, report, {
          id: policy.document.id,
          revision: policy.document.revision,
          commitmentHash: policy.commitmentHash,
        }),
      ),
      envelope = signEffectsAttestation(
        "audit-attestation",
        payload,
        signingKey,
      ),
      signatureText = `${stableJson(envelope)}\n`;
    await assertPolicyUnchanged(policy);
    await durableCreateText(
      resolve(target, "audit-attestation.json"),
      signatureText,
    );
    await assertOutput();
    await assertExactFiles(target, [...fileNames, "audit-attestation.json"]);
    const published = await readEffectsSignatureEnvelope(
      resolve(target, "audit-attestation.json"),
      "audit-attestation",
    );
    if (published.sourceHash !== sha256(signatureText))
      throw new Error("EFFECTS_ATTESTATION_PACKAGE_CHANGED");
    await assertPolicyUnchanged(policy);
    return Object.freeze({
      format: "llang-effects-attestation-package-result",
      version: 1,
      status: report.status,
      auditorKeyId: signingKey.keyId,
      auditHash: payload.audit.auditHash,
      output: basename(target),
    });
  } catch (error) {
    const current = await lstat(target).catch(() => undefined);
    if (
      current?.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === outputInfo.dev &&
      current.ino === outputInfo.ino
    )
      await rm(target, { recursive: true });
    throw error;
  }
}

export async function verifyEffectsAttestationPackage(options: {
  manifestPath: string;
  requirementsPath: string;
  packageDirectory: string;
  trustPolicyPath: string;
}) {
  const packageInput = resolve(options.packageDirectory),
    packageInfo = await lstat(packageInput);
  if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink())
    throw new Error("INVALID_EFFECTS_ATTESTATION_PACKAGE");
  const directory = await realpath(packageInput),
    directoryInfo = await lstat(directory),
    policy = await readEffectsTrustPolicy(options.trustPolicyPath),
    { report, storedReport } = await verifiedAudit({
      manifestPath: options.manifestPath,
      requirementsPath: options.requirementsPath,
      directory,
      trustPolicyPath: options.trustPolicyPath,
      allowPolicyAdvance: true,
    }),
    parsed = await readEffectsSignatureEnvelope(
      resolve(directory, "audit-attestation.json"),
      "audit-attestation",
    ),
    payload = parsePayload(parsed.document.payload),
    fileNames = Object.keys(payload.files).sort(),
    files = await readFiles(directory, fileNames);
  if (
    directoryInfo.dev !== packageInfo.dev ||
    directoryInfo.ino !== packageInfo.ino
  )
    throw new Error("INVALID_EFFECTS_ATTESTATION_PACKAGE");
  assertReportPolicyMatches(report, policy);
  await assertPolicyUnchanged(policy);
  await assertExactFiles(directory, [...fileNames, "audit-attestation.json"]);
  assertEffectsTrustRole(policy, "auditors", parsed.document.keyId);
  const publicKey = policy.publicKeys.get(parsed.document.keyId),
    storedTrust = storedReport.trust,
    storedPolicy = object(storedTrust) ? storedTrust.policy : undefined;
  if (
    !object(storedPolicy) ||
    storedPolicy.id !== policy.document.id ||
    !Number.isSafeInteger(storedPolicy.revision) ||
    Number(storedPolicy.revision) > policy.document.revision ||
    typeof storedPolicy.commitmentHash !== "string" ||
    !HASH.test(storedPolicy.commitmentHash) ||
    (Number(storedPolicy.revision) === policy.document.revision &&
      storedPolicy.commitmentHash !== policy.commitmentHash) ||
    !publicKey ||
    !verifyEffectsAttestation(parsed.document, publicKey) ||
    fingerprintFor(payload) !==
      fingerprintFor(
        payloadFor(files, storedReport, {
          id: String(storedPolicy.id),
          revision: Number(storedPolicy.revision),
          commitmentHash: storedPolicy.commitmentHash,
        }),
      )
  )
    throw new Error("INVALID_EFFECTS_AUDIT_ATTESTATION_SIGNATURE");
  await assertPolicyUnchanged(policy);
  const finalDirectoryInfo = await lstat(directory);
  if (
    !finalDirectoryInfo.isDirectory() ||
    finalDirectoryInfo.isSymbolicLink() ||
    finalDirectoryInfo.dev !== directoryInfo.dev ||
    finalDirectoryInfo.ino !== directoryInfo.ino
  )
    throw new Error("INVALID_EFFECTS_ATTESTATION_PACKAGE");
  return Object.freeze({
    format: "llang-effects-attestation-verification",
    version: 1,
    status:
      report.trustDecision === "trusted" && report.status !== "failed"
        ? "trusted"
        : "rejected",
    signatureStatus: "valid",
    trustDecision: report.trustDecision,
    executionStatus: report.execution
      ? (report.execution as Record<string, unknown>).status
      : undefined,
    auditStatus: report.status,
    auditorKeyId: parsed.document.keyId,
    auditHash: payload.audit.auditHash,
    semanticMeaning: "not-proven",
    freshness: "not-proven",
    antiReplay: "not-provided",
    remoteAttestation: "not-provided",
    apiCalls: 0,
  });
}
