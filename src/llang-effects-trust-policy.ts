import { resolve } from "node:path";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import {
  keyIdFromPublicKey,
  publicKeyFromSpki,
} from "./llang-effects-attestation-crypto";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";
import { fingerprintFor, sha256 } from "./stable-hash";

const ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const KEY_ID = /^ed25519:[0-9a-f]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const sortedUnique = (values: readonly string[]) =>
  values.length === new Set(values).size &&
  values.join("\0") === [...values].sort().join("\0");
const keyIds = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && KEY_ID.test(item)) &&
  sortedUnique(value);

export type EffectsTrustRole =
  | "requirementApprovers"
  | "executionHosts"
  | "auditors";

export type EffectsTrustPolicyDocument = Readonly<{
  format: "llang-effects-trust-policy";
  version: 1;
  id: string;
  revision: number;
  keys: readonly Readonly<{
    keyId: string;
    algorithm: "Ed25519";
    publicKeySpki: string;
  }>[];
  roles: Readonly<Record<EffectsTrustRole, readonly string[]>>;
  revokedKeyIds: readonly string[];
  rules: Readonly<{
    distinctRoleKeys: boolean;
    allowReviewRequired: boolean;
    allowRecoveredExecution: boolean;
  }>;
}>;

export type ParsedEffectsTrustPolicy = Readonly<{
  path: string;
  fileIdentity: Readonly<{ dev: number; ino: number }>;
  sourceHash: string;
  commitmentHash: string;
  document: EffectsTrustPolicyDocument;
  publicKeys: ReadonlyMap<string, ReturnType<typeof publicKeyFromSpki>>;
}>;

export function parseEffectsTrustPolicy(
  value: unknown,
): EffectsTrustPolicyDocument {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "id",
      "revision",
      "keys",
      "roles",
      "revokedKeyIds",
      "rules",
    ]) ||
    value.format !== "llang-effects-trust-policy" ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !Array.isArray(value.keys) ||
    !object(value.roles) ||
    !exact(value.roles, [
      "requirementApprovers",
      "executionHosts",
      "auditors",
    ]) ||
    !keyIds(value.roles.requirementApprovers) ||
    !keyIds(value.roles.executionHosts) ||
    !keyIds(value.roles.auditors) ||
    !keyIds(value.revokedKeyIds) ||
    !object(value.rules) ||
    !exact(value.rules, [
      "distinctRoleKeys",
      "allowReviewRequired",
      "allowRecoveredExecution",
    ]) ||
    typeof value.rules.distinctRoleKeys !== "boolean" ||
    typeof value.rules.allowReviewRequired !== "boolean" ||
    typeof value.rules.allowRecoveredExecution !== "boolean"
  )
    throw new Error("INVALID_EFFECTS_TRUST_POLICY");
  const keys = value.keys.map((raw) => {
    if (
      !object(raw) ||
      !exact(raw, ["keyId", "algorithm", "publicKeySpki"]) ||
      typeof raw.keyId !== "string" ||
      !KEY_ID.test(raw.keyId) ||
      raw.algorithm !== "Ed25519" ||
      typeof raw.publicKeySpki !== "string"
    )
      throw new Error("INVALID_EFFECTS_TRUST_POLICY");
    const publicKey = publicKeyFromSpki(raw.publicKeySpki);
    if (keyIdFromPublicKey(publicKey) !== raw.keyId)
      throw new Error("INVALID_EFFECTS_TRUST_POLICY");
    return Object.freeze({
      keyId: raw.keyId,
      algorithm: "Ed25519" as const,
      publicKeySpki: raw.publicKeySpki,
    });
  });
  if (!sortedUnique(keys.map((key) => key.keyId)))
    throw new Error("INVALID_EFFECTS_TRUST_POLICY");
  const known = new Set(keys.map((key) => key.keyId)),
    roles = Object.freeze({
      requirementApprovers: Object.freeze([
        ...value.roles.requirementApprovers,
      ] as string[]),
      executionHosts: Object.freeze([
        ...value.roles.executionHosts,
      ] as string[]),
      auditors: Object.freeze([...value.roles.auditors] as string[]),
    }),
    allRoles = [
      ...roles.requirementApprovers,
      ...roles.executionHosts,
      ...roles.auditors,
    ];
  if (
    allRoles.some((keyId) => !known.has(keyId)) ||
    (value.revokedKeyIds as string[]).some((keyId) => !known.has(keyId)) ||
    allRoles.some((keyId) =>
      (value.revokedKeyIds as string[]).includes(keyId),
    ) ||
    (value.rules.distinctRoleKeys && new Set(allRoles).size !== allRoles.length)
  )
    throw new Error("INVALID_EFFECTS_TRUST_POLICY");
  return Object.freeze({
    format: "llang-effects-trust-policy",
    version: 1,
    id: value.id,
    revision: Number(value.revision),
    keys: Object.freeze(keys),
    roles,
    revokedKeyIds: Object.freeze([...(value.revokedKeyIds as string[])]),
    rules: Object.freeze({
      distinctRoleKeys: value.rules.distinctRoleKeys,
      allowReviewRequired: value.rules.allowReviewRequired,
      allowRecoveredExecution: value.rules.allowRecoveredExecution,
    }),
  });
}

export async function readEffectsTrustPolicy(
  path: string,
): Promise<ParsedEffectsTrustPolicy> {
  const absolute = resolve(path),
    snapshot = await readStableRegularFileSnapshot(
      absolute,
      1024 * 1024,
      "INVALID_EFFECTS_TRUST_POLICY_FILE",
    ),
    document = parseEffectsTrustPolicy(
      parseStrictJsonObject(decodeUtf8(snapshot.bytes, absolute), absolute),
    ),
    publicKeys = new Map(
      document.keys.map((key) => [
        key.keyId,
        publicKeyFromSpki(key.publicKeySpki),
      ]),
    );
  return Object.freeze({
    path: absolute,
    fileIdentity: Object.freeze({ dev: snapshot.dev, ino: snapshot.ino }),
    sourceHash: sha256(snapshot.bytes),
    commitmentHash: fingerprintFor(document),
    document,
    publicKeys,
  });
}

export function assertEffectsTrustRole(
  policy: ParsedEffectsTrustPolicy,
  role: EffectsTrustRole,
  keyId: string,
): void {
  if (
    policy.document.revokedKeyIds.includes(keyId) ||
    !policy.document.roles[role].includes(keyId) ||
    !policy.publicKeys.has(keyId)
  )
    throw new Error("EFFECTS_ATTESTATION_UNTRUSTED_ROLE");
}

export function assertCurrentPolicyForIssuance(
  issuance: ParsedEffectsTrustPolicy,
  current: ParsedEffectsTrustPolicy,
): void {
  if (
    issuance.document.id !== current.document.id ||
    current.document.revision < issuance.document.revision ||
    (current.document.revision === issuance.document.revision &&
      current.commitmentHash !== issuance.commitmentHash)
  )
    throw new Error("EFFECTS_TRUST_POLICY_ROLLBACK");
}
