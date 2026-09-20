import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  assertEffectsBundleIdentity,
  readVerifiedEffectsExecutionSnapshot,
  type VerifiedEffectsExecutionSnapshot,
} from "./llang-effects-bundle-inspection";
import {
  readEffectsSignatureEnvelope,
  readEffectsSigningKey,
  signEffectsAttestation,
  verifyEffectsAttestation,
  type EffectsSignatureEnvelope,
} from "./llang-effects-attestation-crypto";
import { pathsOverlap } from "./llang-effects-execution-grant";
import {
  assertEffectsRequirementIdentity,
  readEffectsRequirementContract,
  type ParsedEffectsRequirementContract,
} from "./llang-effects-requirement-contract";
import {
  assertEffectsTrustRole,
  type ParsedEffectsTrustPolicy,
} from "./llang-effects-trust-policy";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";
import {
  readEffectsTrustBoundary,
  type ParsedEffectsTrustBoundary,
} from "./llang-effects-trust-boundary";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";

const HASH = /^[0-9a-f]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

export type EffectsRequirementApprovalPayload = Readonly<{
  format: "llang-effects-requirement-approval";
  version: 1 | 2;
  requirements: Readonly<{
    id: string;
    revision: number;
    sourceHash: string;
    commitmentHash: string;
    authorityCommitmentHash: string;
    coverage: ParsedEffectsRequirementContract["coverage"];
    expectedTerminalStatuses: readonly string[];
  }>;
  bundle: Readonly<{
    bundleIdentityHash: string;
    entry: string;
    profile: string;
    abi: string;
    bundledWasmHash: string;
  }>;
  semanticMeaning: "not-proven";
  boundary?: Readonly<{
    id: string;
    revision: number;
    sourceHash: string;
    commitmentHash: string;
    provenanceHash: string;
  }>;
}>;

export type ParsedEffectsRequirementApproval = Readonly<{
  path: string;
  fileIdentity: Readonly<{ dev: number; ino: number }>;
  sourceHash: string;
  document: EffectsSignatureEnvelope;
  payload: EffectsRequirementApprovalPayload;
}>;

export function parseEffectsRequirementApprovalPayload(
  value: Readonly<Record<string, unknown>>,
): EffectsRequirementApprovalPayload {
  if (
    !exact(
      value,
      value.version === 2
        ? [
            "format",
            "version",
            "requirements",
            "bundle",
            "semanticMeaning",
            "boundary",
          ]
        : ["format", "version", "requirements", "bundle", "semanticMeaning"],
    ) ||
    value.format !== "llang-effects-requirement-approval" ||
    (value.version !== 1 && value.version !== 2) ||
    value.semanticMeaning !== "not-proven" ||
    !object(value.requirements) ||
    !exact(value.requirements, [
      "id",
      "revision",
      "sourceHash",
      "commitmentHash",
      "authorityCommitmentHash",
      "coverage",
      "expectedTerminalStatuses",
    ]) ||
    typeof value.requirements.id !== "string" ||
    !Number.isSafeInteger(value.requirements.revision) ||
    !HASH.test(String(value.requirements.sourceHash)) ||
    !HASH.test(String(value.requirements.commitmentHash)) ||
    !HASH.test(String(value.requirements.authorityCommitmentHash)) ||
    !object(value.requirements.coverage) ||
    !Array.isArray(value.requirements.expectedTerminalStatuses) ||
    !value.requirements.expectedTerminalStatuses.every(
      (status) => typeof status === "string",
    ) ||
    !object(value.bundle) ||
    !exact(value.bundle, [
      "bundleIdentityHash",
      "entry",
      "profile",
      "abi",
      "bundledWasmHash",
    ]) ||
    !HASH.test(String(value.bundle.bundleIdentityHash)) ||
    typeof value.bundle.entry !== "string" ||
    typeof value.bundle.profile !== "string" ||
    typeof value.bundle.abi !== "string" ||
    !HASH.test(String(value.bundle.bundledWasmHash)) ||
    (value.version === 2 &&
      (!object(value.boundary) ||
        !exact(value.boundary, [
          "id",
          "revision",
          "sourceHash",
          "commitmentHash",
          "provenanceHash",
        ]) ||
        typeof value.boundary.id !== "string" ||
        !Number.isSafeInteger(value.boundary.revision) ||
        Number(value.boundary.revision) < 1 ||
        !HASH.test(String(value.boundary.sourceHash)) ||
        !HASH.test(String(value.boundary.commitmentHash)) ||
        !HASH.test(String(value.boundary.provenanceHash))))
  )
    throw new Error("INVALID_EFFECTS_REQUIREMENT_APPROVAL");
  return value as EffectsRequirementApprovalPayload;
}

function approvalPayload(
  snapshot: VerifiedEffectsExecutionSnapshot,
  requirements: ParsedEffectsRequirementContract,
  boundary?: ParsedEffectsTrustBoundary,
): EffectsRequirementApprovalPayload {
  return Object.freeze({
    format: "llang-effects-requirement-approval",
    version: boundary ? 2 : 1,
    requirements: Object.freeze({
      id: requirements.document.id,
      revision: requirements.document.revision,
      sourceHash: requirements.sourceHash,
      commitmentHash: requirements.commitmentHash,
      authorityCommitmentHash: requirements.authorityCommitmentHash,
      coverage: requirements.coverage,
      expectedTerminalStatuses: requirements.document.expectedTerminalStatuses,
    }),
    bundle: Object.freeze({
      bundleIdentityHash: snapshot.bundleIdentityHash,
      entry: snapshot.manifest.entry,
      profile: snapshot.manifest.profile,
      abi: snapshot.manifest.abi,
      bundledWasmHash: sha256(snapshot.wasmBytes),
    }),
    semanticMeaning: "not-proven",
    ...(boundary
      ? {
          boundary: Object.freeze({
            id: boundary.document.id,
            revision: boundary.document.revision,
            sourceHash: boundary.sourceHash,
            commitmentHash: boundary.commitmentHash,
            provenanceHash: boundary.provenanceHash,
          }),
        }
      : {}),
  });
}

function assertApprovalMatches(
  payload: EffectsRequirementApprovalPayload,
  snapshot: VerifiedEffectsExecutionSnapshot,
  requirements: ParsedEffectsRequirementContract,
  boundary?: ParsedEffectsTrustBoundary,
): void {
  if (
    fingerprintFor(payload) !==
    fingerprintFor(approvalPayload(snapshot, requirements, boundary))
  )
    throw new Error("EFFECTS_REQUIREMENT_APPROVAL_MISMATCH");
}

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

export async function createEffectsRequirementApproval(options: {
  manifestPath: string;
  requirementsPath: string;
  signingKeyPath: string;
  outputPath: string;
  trustBoundaryPath?: string;
}) {
  const snapshot = await readVerifiedEffectsExecutionSnapshot(
      options.manifestPath,
    ),
    requirements = await readEffectsRequirementContract(
      options.requirementsPath,
      snapshot.bundleIdentityHash,
      snapshot.graph,
    ),
    boundary = options.trustBoundaryPath
      ? await readEffectsTrustBoundary(
          options.trustBoundaryPath,
          requirements,
          snapshot.graph,
        )
      : undefined,
    signingKey = await readEffectsSigningKey(options.signingKeyPath),
    outputInput = resolve(options.outputPath),
    parentInfo = await lstat(dirname(outputInput));
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new Error("INVALID_REQUIREMENT_APPROVAL_OUTPUT_PARENT");
  const parent = await realpath(dirname(outputInput)),
    output = resolve(parent, basename(outputInput)),
    bundleRoot = await realpath(dirname(resolve(options.manifestPath))),
    requirementsFile = await realpath(resolve(options.requirementsPath));
  if (
    pathsOverlap(bundleRoot, output) ||
    pathsOverlap(requirementsFile, output) ||
    (boundary && pathsOverlap(await realpath(boundary.path), output))
  )
    throw new Error("REQUIREMENT_APPROVAL_OUTPUT_OVERLAPS_INPUT");
  const envelope = signEffectsAttestation(
      "requirement-approval",
      approvalPayload(snapshot, requirements, boundary),
      signingKey,
    ),
    text = `${stableJson(envelope)}\n`;
  await assertEffectsBundleIdentity(
    options.manifestPath,
    snapshot.bundleIdentityHash,
  );
  await assertEffectsRequirementIdentity(
    requirements,
    snapshot.bundleIdentityHash,
    snapshot.graph,
  );
  if (boundary) {
    const currentBoundary = await readStableRegularFileSnapshot(
      boundary.path,
      1024 * 1024,
      "EFFECTS_TRUST_BOUNDARY_CHANGED",
    );
    if (
      currentBoundary.dev !== boundary.fileIdentity.dev ||
      currentBoundary.ino !== boundary.fileIdentity.ino ||
      sha256(currentBoundary.bytes) !== boundary.sourceHash
    )
      throw new Error("EFFECTS_TRUST_BOUNDARY_CHANGED");
  }
  await durableCreateText(output, text);
  const published = await readEffectsSignatureEnvelope(
    output,
    "requirement-approval",
  );
  if (published.sourceHash !== sha256(text))
    throw new Error("REQUIREMENT_APPROVAL_OUTPUT_CHANGED");
  return Object.freeze({
    format: "llang-effects-requirement-approval-result",
    version: 1,
    keyId: envelope.keyId,
    payloadHash: envelope.payloadHash,
    sourceHash: published.sourceHash,
    output: basename(output),
    semanticMeaning: "not-proven",
  });
}

export async function readAndVerifyEffectsRequirementApproval(options: {
  approvalPath: string;
  snapshot: VerifiedEffectsExecutionSnapshot;
  requirements: ParsedEffectsRequirementContract;
  policy: ParsedEffectsTrustPolicy;
  boundary?: ParsedEffectsTrustBoundary;
}): Promise<ParsedEffectsRequirementApproval> {
  const parsed = await readEffectsSignatureEnvelope(
      options.approvalPath,
      "requirement-approval",
    ),
    payload = parseEffectsRequirementApprovalPayload(parsed.document.payload);
  assertEffectsTrustRole(
    options.policy,
    "requirementApprovers",
    parsed.document.keyId,
  );
  const publicKey = options.policy.publicKeys.get(parsed.document.keyId);
  if (!publicKey || !verifyEffectsAttestation(parsed.document, publicKey))
    throw new Error("INVALID_EFFECTS_REQUIREMENT_APPROVAL_SIGNATURE");
  assertApprovalMatches(
    payload,
    options.snapshot,
    options.requirements,
    options.boundary,
  );
  return Object.freeze({ ...parsed, payload });
}
