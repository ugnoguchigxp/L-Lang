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
): Promise<Readonly<Record<string, unknown>>> {
  const directory = resolve(evidenceDirectory),
    info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("INVALID_EXECUTION_EVIDENCE_DIRECTORY");
  const intentPath = resolve(directory, "execution-intent.json"),
    lockPath = resolve(directory, "execution.lock"),
    transcriptPath = resolve(directory, "effects-transcript.jsonl"),
    reportPath = resolve(directory, "effects-execution.json");
  try {
    await lstat(reportPath);
    throw new Error("EXECUTION_REPORT_ALREADY_EXISTS");
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
      ...(intentVersion === 2 ? ["grantSummary", "requirements"] : []),
    ];
  if (
    !exact(intent, intentKeys) ||
    intent.format !== "llang-effects-execution-intent" ||
    (intentVersion !== 1 && intentVersion !== 2) ||
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
    (intentVersion === 2 &&
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
  if (intentVersion === 2) assertEffectsGrantSummaryShape(intent.grantSummary);
  if (processIsLive(lock.pid)) throw new Error("EXECUTION_OWNER_IS_LIVE");

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
        ...(intentVersion === 2 ? { summary: intent.grantSummary } : {}),
      },
      ...(intentVersion === 2 && requirementBinding
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
          intentVersion === 2 &&
          intent.credentialInjection === "host-provided-not-recorded"
            ? "accessed"
            : intent.credentialInjection,
        headerNames: intent.credentialHeaderNames,
        values: "not-recorded",
      },
      authenticity: {
        attestation: "not-signed",
        retention: "caller-managed",
      },
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
    report = Object.freeze({
      ...base,
      authenticity: { ...base.authenticity, evidenceHash },
    });
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
  await durableCreateText(reportPath, `${stableJson(report)}\n`);
  await assertRecoveryOwnership();
  if (sha256(await regularBytes(lockPath)) !== lockHash)
    throw new Error("EXECUTION_EVIDENCE_FILE_CHANGED");
  await unlink(lockPath);
  return report;
}
