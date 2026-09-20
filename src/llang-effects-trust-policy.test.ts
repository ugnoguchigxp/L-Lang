import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  keyIdFromPublicKey,
  publicKeySpki,
} from "./llang-effects-attestation-crypto";
import {
  assertCurrentPolicyForIssuance,
  assertEffectsTrustRole,
  parseEffectsTrustPolicy,
} from "./llang-effects-trust-policy";
import { fingerprintFor } from "./stable-hash";

function key(seedByte: number) {
  const privateDer = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.alloc(32, seedByte),
    ]),
    privateKey = createPrivateKey({
      key: privateDer,
      format: "der",
      type: "pkcs8",
    }),
    publicKey = createPublicKey(
      privateKey.export({ format: "pem", type: "pkcs8" }),
    );
  return {
    keyId: keyIdFromPublicKey(publicKey),
    algorithm: "Ed25519" as const,
    publicKeySpki: publicKeySpki(publicKey),
  };
}

function policy(revision = 1) {
  const keys = [key(1), key(2), key(3)].sort((a, b) =>
      a.keyId.localeCompare(b.keyId),
    ),
    [requester, host, auditor] = keys;
  if (!requester || !host || !auditor) throw new Error("test fixture");
  return {
    format: "llang-effects-trust-policy",
    version: 1,
    id: "local-effects",
    revision,
    keys,
    roles: {
      requirementApprovers: [requester.keyId],
      executionHosts: [host.keyId],
      auditors: [auditor.keyId],
    },
    revokedKeyIds: [],
    rules: {
      distinctRoleKeys: true,
      allowReviewRequired: false,
      allowRecoveredExecution: true,
    },
  };
}

function parsed(document: ReturnType<typeof policy>) {
  const parsedDocument = parseEffectsTrustPolicy(document);
  return Object.freeze({
    path: "/policy.json",
    fileIdentity: Object.freeze({ dev: 1, ino: 1 }),
    sourceHash: "0".repeat(64),
    commitmentHash: fingerprintFor(parsedDocument),
    document: parsedDocument,
    publicKeys: new Map(
      parsedDocument.keys.map((item) => [
        item.keyId,
        createPublicKey({
          key: Buffer.from(item.publicKeySpki, "base64"),
          format: "der",
          type: "spki",
        }),
      ]),
    ),
  });
}

describe("Effects trust policy", () => {
  test("parses role-separated keys and enforces current roles", () => {
    const value = parsed(policy()),
      requester = value.document.roles.requirementApprovers[0] as string;
    expect(() =>
      assertEffectsTrustRole(value, "requirementApprovers", requester),
    ).not.toThrow();
    expect(() =>
      assertEffectsTrustRole(value, "executionHosts", requester),
    ).toThrow("EFFECTS_ATTESTATION_UNTRUSTED_ROLE");
  });

  test("rejects key confusion, duplicate roles, revocation conflicts, and rollback", () => {
    const base = policy(),
      requester = base.roles.requirementApprovers[0] as string;
    expect(() =>
      parseEffectsTrustPolicy({
        ...base,
        keys: [{ ...base.keys[0], keyId: `ed25519:${"0".repeat(64)}` }],
      }),
    ).toThrow("INVALID_EFFECTS_TRUST_POLICY");
    expect(() =>
      parseEffectsTrustPolicy({
        ...base,
        roles: { ...base.roles, executionHosts: [requester] },
      }),
    ).toThrow("INVALID_EFFECTS_TRUST_POLICY");
    expect(() =>
      parseEffectsTrustPolicy({ ...base, revokedKeyIds: [requester] }),
    ).toThrow("INVALID_EFFECTS_TRUST_POLICY");
    expect(() =>
      assertCurrentPolicyForIssuance(parsed(policy(2)), parsed(policy(1))),
    ).toThrow("EFFECTS_TRUST_POLICY_ROLLBACK");
    const replacement = policy();
    replacement.rules.allowRecoveredExecution = false;
    expect(() =>
      assertCurrentPolicyForIssuance(parsed(base), parsed(replacement)),
    ).toThrow("EFFECTS_TRUST_POLICY_ROLLBACK");
  });
});
