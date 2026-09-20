import { open, readFile } from "node:fs/promises";
import { parseEffectsTrustPolicy } from "../../src/llang-effects-trust-policy";
import { stableJson } from "../../src/stable-hash";

const [, , outputPath, approverPath, hostPath, auditorPath] = process.argv;
if (!outputPath || !approverPath || !hostPath || !auditorPath)
  throw new Error(
    "usage: create-attestation-policy.ts <output> <approver-public.json> <host-public.json> <auditor-public.json>",
  );

const keys = await Promise.all(
    [approverPath, hostPath, auditorPath].map(
      async (path) =>
        JSON.parse(await readFile(path, "utf8")) as {
          keyId: string;
          algorithm: "Ed25519";
          publicKeySpki: string;
        },
    ),
  ),
  document = parseEffectsTrustPolicy({
    format: "llang-effects-trust-policy",
    version: 1,
    id: "module-io-pipeline.local",
    revision: 1,
    keys: keys
      .map(({ keyId, algorithm, publicKeySpki }) => ({
        keyId,
        algorithm,
        publicKeySpki,
      }))
      .sort((left, right) => left.keyId.localeCompare(right.keyId)),
    roles: {
      requirementApprovers: [keys[0]?.keyId],
      executionHosts: [keys[1]?.keyId],
      auditors: [keys[2]?.keyId],
    },
    revokedKeyIds: [],
    rules: {
      distinctRoleKeys: true,
      allowReviewRequired: false,
      allowRecoveredExecution: false,
    },
  }),
  output = await open(outputPath, "wx", 0o600);
try {
  await output.writeFile(`${stableJson(document)}\n`);
  await output.sync();
} finally {
  await output.close();
}

console.log(
  JSON.stringify({
    ok: true,
    policyId: document.id,
    revision: document.revision,
    roles: document.roles,
  }),
);
