import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";

const MAX_KEY_BYTES = 64 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const KEY_ID = /^ed25519:[0-9a-f]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const KINDS = [
  "requirement-approval",
  "execution-attestation",
  "audit-attestation",
] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

export type EffectsAttestationKind = (typeof KINDS)[number];
export type EffectsSignatureEnvelope = Readonly<{
  format: "llang-effects-signature";
  version: 1;
  artifactKind: EffectsAttestationKind;
  algorithm: "Ed25519";
  keyId: string;
  payload: Readonly<Record<string, unknown>>;
  payloadHash: string;
  signature: string;
}>;

export type EffectsSigningKey = Readonly<{
  keyId: string;
  privateKey: KeyObject;
  publicKeySpki: string;
}>;

function canonicalBase64(value: string): Uint8Array {
  if (!value || !BASE64.test(value))
    throw new Error("INVALID_ATTESTATION_BASE64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error("INVALID_ATTESTATION_BASE64");
  return bytes;
}

export function keyIdFromPublicKey(publicKey: KeyObject): string {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("INVALID_ATTESTATION_PUBLIC_KEY");
  const der = publicKey.export({ format: "der", type: "spki" });
  return `ed25519:${sha256(der)}`;
}

export function publicKeyFromSpki(value: string): KeyObject {
  const bytes = canonicalBase64(value);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch (error) {
    throw new Error("INVALID_ATTESTATION_PUBLIC_KEY", { cause: error });
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("INVALID_ATTESTATION_PUBLIC_KEY");
  return key;
}

export function publicKeySpki(publicKey: KeyObject): string {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("INVALID_ATTESTATION_PUBLIC_KEY");
  return Buffer.from(
    publicKey.export({ format: "der", type: "spki" }),
  ).toString("base64");
}

function signingBytes(
  kind: EffectsAttestationKind,
  payload: Readonly<Record<string, unknown>>,
): Uint8Array {
  return new TextEncoder().encode(
    `L-Lang Effects Attestation\x00${kind}\x001\x00${stableJson(payload)}`,
  );
}

export function parseEffectsSignatureEnvelope(
  value: unknown,
  expectedKind?: EffectsAttestationKind,
): EffectsSignatureEnvelope {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "artifactKind",
      "algorithm",
      "keyId",
      "payload",
      "payloadHash",
      "signature",
    ]) ||
    value.format !== "llang-effects-signature" ||
    value.version !== 1 ||
    !KINDS.includes(value.artifactKind as EffectsAttestationKind) ||
    (expectedKind !== undefined && value.artifactKind !== expectedKind) ||
    value.algorithm !== "Ed25519" ||
    typeof value.keyId !== "string" ||
    !KEY_ID.test(value.keyId) ||
    !object(value.payload) ||
    typeof value.payloadHash !== "string" ||
    !HASH.test(value.payloadHash) ||
    value.payloadHash !== fingerprintFor(value.payload) ||
    typeof value.signature !== "string"
  )
    throw new Error("INVALID_EFFECTS_SIGNATURE");
  const signature = canonicalBase64(value.signature);
  if (signature.byteLength !== 64) throw new Error("INVALID_EFFECTS_SIGNATURE");
  return Object.freeze({
    format: "llang-effects-signature",
    version: 1,
    artifactKind: value.artifactKind as EffectsAttestationKind,
    algorithm: "Ed25519",
    keyId: value.keyId,
    payload: Object.freeze({ ...value.payload }),
    payloadHash: value.payloadHash,
    signature: value.signature,
  });
}

export function signEffectsAttestation(
  kind: EffectsAttestationKind,
  payload: Readonly<Record<string, unknown>>,
  signingKey: EffectsSigningKey,
): EffectsSignatureEnvelope {
  const signature = sign(
    null,
    signingBytes(kind, payload),
    signingKey.privateKey,
  );
  return Object.freeze({
    format: "llang-effects-signature",
    version: 1,
    artifactKind: kind,
    algorithm: "Ed25519",
    keyId: signingKey.keyId,
    payload: Object.freeze({ ...payload }),
    payloadHash: fingerprintFor(payload),
    signature: signature.toString("base64"),
  });
}

export function verifyEffectsAttestation(
  envelope: EffectsSignatureEnvelope,
  publicKey: KeyObject,
): boolean {
  if (keyIdFromPublicKey(publicKey) !== envelope.keyId) return false;
  return verify(
    null,
    signingBytes(envelope.artifactKind, envelope.payload),
    publicKey,
    canonicalBase64(envelope.signature),
  );
}

export async function readEffectsSignatureEnvelope(
  path: string,
  expectedKind?: EffectsAttestationKind,
) {
  const absolute = resolve(path),
    snapshot = await readStableRegularFileSnapshot(
      absolute,
      1024 * 1024,
      "INVALID_EFFECTS_SIGNATURE_FILE",
    ),
    document = parseEffectsSignatureEnvelope(
      parseStrictJsonObject(decodeUtf8(snapshot.bytes, absolute), absolute),
      expectedKind,
    );
  if (decodeUtf8(snapshot.bytes, absolute) !== `${stableJson(document)}\n`)
    throw new Error("INVALID_EFFECTS_SIGNATURE_FILE");
  return Object.freeze({
    path: absolute,
    fileIdentity: Object.freeze({ dev: snapshot.dev, ino: snapshot.ino }),
    sourceHash: sha256(snapshot.bytes),
    document,
  });
}

export async function readEffectsSigningKey(
  path: string,
): Promise<EffectsSigningKey> {
  const absolute = resolve(path),
    before = await lstat(absolute);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  )
    throw new Error("INVALID_ATTESTATION_PRIVATE_KEY");
  const snapshot = await readStableRegularFileSnapshot(
    absolute,
    MAX_KEY_BYTES,
    "INVALID_ATTESTATION_PRIVATE_KEY",
  );
  if (
    snapshot.dev !== before.dev ||
    snapshot.ino !== before.ino ||
    (process.platform !== "win32" && (snapshot.mode & 0o077) !== 0)
  )
    throw new Error("INVALID_ATTESTATION_PRIVATE_KEY");
  let privateKey: KeyObject, publicKey: KeyObject;
  const bytes = Buffer.from(snapshot.bytes);
  try {
    privateKey = createPrivateKey(bytes);
    publicKey = createPublicKey(bytes);
  } catch (error) {
    throw new Error("INVALID_ATTESTATION_PRIVATE_KEY", { cause: error });
  } finally {
    bytes.fill(0);
  }
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("INVALID_ATTESTATION_PRIVATE_KEY");
  const keyId = keyIdFromPublicKey(publicKey);
  return Object.freeze({
    keyId,
    privateKey,
    publicKeySpki: publicKeySpki(publicKey),
  });
}

async function durableWrite(path: string, bytes: string, mode: number) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function generateEffectsAttestationKeyPair(
  outputDirectory: string,
) {
  const input = resolve(outputDirectory),
    parentInfo = await lstat(dirname(input));
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new Error("INVALID_ATTESTATION_KEY_OUTPUT_PARENT");
  const parent = await realpath(dirname(input)),
    output = resolve(parent, basename(input));
  await mkdir(output, { mode: 0o700 });
  const info = await lstat(output);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("INVALID_ATTESTATION_KEY_OUTPUT");
  const pair = generateKeyPairSync("ed25519"),
    keyId = keyIdFromPublicKey(pair.publicKey),
    privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    publicDocument = {
      format: "llang-effects-public-key",
      version: 1,
      algorithm: "Ed25519",
      keyId,
      publicKeySpki: publicKeySpki(pair.publicKey),
    };
  try {
    await durableWrite(resolve(output, "private-key.pem"), privatePem, 0o600);
    await durableWrite(
      resolve(output, "public-key.json"),
      `${stableJson(publicDocument)}\n`,
      0o644,
    );
  } catch (error) {
    const current = await lstat(output).catch(() => undefined);
    if (
      current?.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === info.dev &&
      current.ino === info.ino
    )
      await rm(output, { recursive: true });
    throw error;
  }
  return Object.freeze({
    format: "llang-effects-key-generation",
    version: 1,
    keyId,
    privateKey: "private-key.pem",
    publicKey: "public-key.json",
    privateKeyProtection:
      process.platform === "win32" ? "caller-managed-acl" : "mode-0600",
  });
}
