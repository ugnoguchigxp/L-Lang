import { afterEach, describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateEffectsAttestationKeyPair,
  keyIdFromPublicKey,
  parseEffectsSignatureEnvelope,
  publicKeySpki,
  readEffectsSigningKey,
  signEffectsAttestation,
  verifyEffectsAttestation,
} from "./llang-effects-attestation-crypto";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function fixedSigningKey() {
  const seed = Buffer.from(
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    ),
    privateDer = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    privateKey = createPrivateKey({
      key: privateDer,
      format: "der",
      type: "pkcs8",
    }),
    publicKey = createPublicKey(
      privateKey.export({ format: "pem", type: "pkcs8" }),
    );
  return Object.freeze({
    keyId: keyIdFromPublicKey(publicKey),
    privateKey,
    publicKeySpki: publicKeySpki(publicKey),
  });
}

describe("Effects attestation crypto", () => {
  test("signs one canonical domain-separated Ed25519 payload", () => {
    const signingKey = fixedSigningKey(),
      payload = Object.freeze({
        format: "llang-effects-requirement-approval",
        version: 1,
        commitmentHash: "a".repeat(64),
      }),
      envelope = signEffectsAttestation(
        "requirement-approval",
        payload,
        signingKey,
      ),
      publicKey = createPublicKey({
        key: Buffer.from(signingKey.publicKeySpki, "base64"),
        format: "der",
        type: "spki",
      });
    expect(envelope.keyId).toBe(
      "ed25519:06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9",
    );
    expect(envelope.signature).toBe(
      "JvSELaIhZVPd2OgyOZZKGZPEXm/V6ov5BAnvXzDkczAHrC+d8Lq0iA4JnU215twb3UAAzZI1i7OBhazefcwxDA==",
    );
    expect(verifyEffectsAttestation(envelope, publicKey)).toBe(true);
    expect(
      verifyEffectsAttestation(
        { ...envelope, artifactKind: "audit-attestation" },
        publicKey,
      ),
    ).toBe(false);
  });

  test("strictly rejects malformed envelopes and noncanonical base64", () => {
    const envelope = signEffectsAttestation(
      "requirement-approval",
      { value: 1 },
      fixedSigningKey(),
    );
    expect(() =>
      parseEffectsSignatureEnvelope({ ...envelope, extra: true }),
    ).toThrow("INVALID_EFFECTS_SIGNATURE");
    expect(() =>
      parseEffectsSignatureEnvelope({ ...envelope, signature: "AAAA" }),
    ).toThrow("INVALID_EFFECTS_SIGNATURE");
    expect(() =>
      parseEffectsSignatureEnvelope({ ...envelope, signature: "-" }),
    ).toThrow();
  });

  test("generates exclusive keys and rejects an overexposed private key", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-attestation-key-"));
    temporary.push(root);
    const output = join(root, "key"),
      generated = await generateEffectsAttestationKeyPair(output),
      privatePath = join(output, "private-key.pem"),
      signingKey = await readEffectsSigningKey(privatePath),
      publicDocument = JSON.parse(
        await readFile(join(output, "public-key.json"), "utf8"),
      );
    expect(signingKey.keyId).toBe(generated.keyId);
    expect(publicDocument.keyId).toBe(generated.keyId);
    if (process.platform !== "win32") {
      await chmod(privatePath, 0o644);
      expect(readEffectsSigningKey(privatePath)).rejects.toThrow(
        "INVALID_ATTESTATION_PRIVATE_KEY",
      );
    }
    expect(generateEffectsAttestationKeyPair(output)).rejects.toThrow();
    await writeFile(join(root, "not-a-key.pem"), "secret", { mode: 0o600 });
    expect(readEffectsSigningKey(join(root, "not-a-key.pem"))).rejects.toThrow(
      "INVALID_ATTESTATION_PRIVATE_KEY",
    );
  });
});
