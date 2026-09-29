import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

export type StudyLockCode =
  | "PAPER_STUDY_LOCKED"
  | "PAPER_STUDY_LOCK_IO"
  | "PAPER_STUDY_LOCK_RELEASE_FAILED";

export class StudyLockError extends Error {
  constructor(
    public readonly code: StudyLockCode,
    message: string,
    cause?: unknown,
  ) {
    super(`${code}: ${message}`, { cause });
    this.name = "StudyLockError";
  }
}

type LockHandle = Pick<FileHandle, "writeFile" | "sync" | "stat" | "close">;
export type StudyLockIO = {
  realpath: typeof realpath;
  stat: typeof stat;
  lstat: typeof lstat;
  open: (path: string, flags: "wx", mode: number) => Promise<LockHandle>;
  readFile: typeof readFile;
  unlink: typeof unlink;
};
const defaultIO: StudyLockIO = {
  realpath,
  stat,
  lstat,
  open,
  readFile,
  unlink,
};
type Identity = { dev: number; ino: number };
const sameIdentity = (value: Identity, expected: Identity) =>
  value.dev === expected.dev && value.ino === expected.ino;
const ownerKeys = ["version", "format", "ownerToken", "pid"];

function parseOwner(raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid owner record");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== ownerKeys.length ||
    !ownerKeys.every((key) => Object.hasOwn(value, key))
  )
    throw new Error("invalid owner record");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.format !== "llang-paper-study-lock" ||
    typeof record.ownerToken !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.ownerToken,
    ) ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) <= 0
  )
    throw new Error("invalid owner record");
  return record as {
    version: 1;
    format: "llang-paper-study-lock";
    ownerToken: string;
    pid: number;
  };
}

async function matchingFile(path: string, identity: Identity, io: StudyLockIO) {
  const entry = await io.lstat(path);
  return entry.isFile() && sameIdentity(entry, identity);
}

async function release(
  path: string,
  handle: LockHandle,
  identity: Identity,
  ownerToken: string,
  io: StudyLockIO,
) {
  let releaseFailure: unknown;
  try {
    const entry = await io.lstat(path);
    if (!entry.isFile() || !sameIdentity(entry, identity))
      throw new Error("lock entry changed");
    if (entry.size > 1024) throw new Error("lock owner record is too large");
    const owner = parseOwner(await io.readFile(path, "utf8"));
    if (owner.ownerToken !== ownerToken) throw new Error("lock owner changed");
    await io.unlink(path);
  } catch (error) {
    releaseFailure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    releaseFailure = releaseFailure
      ? { releaseFailure, closeFailure: error }
      : error;
  }
  if (releaseFailure)
    throw new StudyLockError(
      "PAPER_STUDY_LOCK_RELEASE_FAILED",
      "could not verify and release study lock",
      releaseFailure,
    );
}

export async function withStudyRunLock<T>(
  runDir: string,
  action: (canonicalDir: string) => Promise<T>,
  io: StudyLockIO = defaultIO,
): Promise<T> {
  let canonicalDir: string;
  try {
    canonicalDir = await io.realpath(runDir);
    if (!(await io.stat(canonicalDir)).isDirectory())
      throw new Error("study run root is not a directory");
  } catch (error) {
    throw new StudyLockError(
      "PAPER_STUDY_LOCK_IO",
      "invalid study run root",
      error,
    );
  }
  const lockPath = resolve(canonicalDir, ".paper-study.lock");
  let handle: LockHandle;
  try {
    handle = await io.open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new StudyLockError(
        "PAPER_STUDY_LOCKED",
        "study run is locked",
        error,
      );
    throw new StudyLockError(
      "PAPER_STUDY_LOCK_IO",
      "could not create study lock",
      error,
    );
  }
  const ownerToken = randomUUID();
  let identity: Identity | null = null;
  try {
    const created = await handle.stat();
    identity = { dev: created.dev, ino: created.ino };
    await handle.writeFile(
      `${JSON.stringify({ version: 1, format: "llang-paper-study-lock", ownerToken, pid: process.pid })}\n`,
    );
    await handle.sync();
    const entry = await io.lstat(lockPath);
    if (!entry.isFile() || !sameIdentity(entry, identity))
      throw new Error("lock entry changed during acquisition");
    if (entry.size > 1024)
      throw new Error("lock owner record is too large during acquisition");
    const readback = parseOwner(await io.readFile(lockPath, "utf8"));
    if (readback.ownerToken !== ownerToken)
      throw new Error("lock owner changed during acquisition");
  } catch (error) {
    const failures: unknown[] = [error];
    let removedOwnEntry = false;
    if (identity) {
      try {
        if (await matchingFile(lockPath, identity, io)) {
          await io.unlink(lockPath);
          removedOwnEntry = true;
        }
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    try {
      await handle.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    throw new StudyLockError(
      "PAPER_STUDY_LOCK_IO",
      removedOwnEntry
        ? "study lock acquisition failed"
        : "study lock acquisition failed; entry may remain",
      failures.length === 1 ? error : failures,
    );
  }
  let result: T | undefined;
  let actionError: unknown;
  let actionFailed = false;
  try {
    result = await action(canonicalDir);
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  try {
    await release(lockPath, handle, identity, ownerToken, io);
  } catch (error) {
    if (actionFailed)
      throw new StudyLockError(
        "PAPER_STUDY_LOCK_RELEASE_FAILED",
        "study lock release failed after action failure",
        { actionError, releaseError: error },
      );
    throw error;
  }
  if (actionFailed) throw actionError;
  return result as T;
}
