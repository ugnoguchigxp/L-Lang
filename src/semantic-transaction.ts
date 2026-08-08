import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { atomicWriteFile } from "./atomic-file";
import { assertKnownKeys, parseBoundedJsonText } from "./semantic-limits";

export type SemanticTransactionCommand = "build" | "replay" | "approve";
export type SemanticTransactionState =
  | "prepared"
  | "output-applied"
  | "tested"
  | "committed"
  | "rolled-back";

export type SemanticTransactionFailurePoint =
  | "workspace-lock-acquired"
  | "journal-created"
  | "output-applied"
  | "full-test-passed"
  | "lock-applied"
  | "committed";

export type SemanticTransactionJournal = {
  version: 1;
  id: string;
  state: SemanticTransactionState;
  outputPath: string;
  lockPath: string;
  previousOutputHash: string | null;
  previousLockHash: string | null;
  nextOutputHash: string;
  nextLockHash: string;
  createdAt: string;
  updatedAt: string;
};

type WorkspaceLock = {
  version: 1;
  transactionId: string;
  pid: number;
  command: SemanticTransactionCommand;
  startedAt: string;
  workspaceHash: string;
};

export class SemanticSimulatedCrash extends Error {
  constructor(point: SemanticTransactionFailurePoint) {
    super(`simulated semantic transaction crash at ${point}`);
    this.name = "SemanticSimulatedCrash";
  }
}

export async function executeSemanticTransaction(input: {
  transactionRoot?: string;
  outputPath: string;
  nextOutput: string | Uint8Array;
  lockPath: string;
  nextLock: string | Uint8Array;
  expectedLockHash?: string | null;
  command: SemanticTransactionCommand;
  runFullTest: () => Promise<void>;
  applyLock?: () => Promise<void>;
  preserveLock?: boolean;
  failureInjector?: (
    point: SemanticTransactionFailurePoint,
  ) => void | Promise<void>;
}): Promise<void> {
  const transactionRoot = resolve(
    input.transactionRoot ?? dirname(input.lockPath),
  );
  const outputPath = await resolveProtectedPath(
    transactionRoot,
    input.outputPath,
    "generated output",
  );
  const lockPath = await resolveProtectedPath(
    transactionRoot,
    input.lockPath,
    "semantic lock",
  );
  const transactionId = randomUUID();
  const semanticRoot = resolve(transactionRoot, ".semantic");
  const transactionDirectory = resolve(
    semanticRoot,
    "transactions",
    transactionId,
  );
  const workspaceLockPath = resolve(semanticRoot, "workspace.lock");
  const nextOutput = asBytes(input.nextOutput);
  const requestedNextLock = asBytes(input.nextLock);
  let workspaceLockAcquired = false;
  let journal: SemanticTransactionJournal | undefined;
  let preserveForRecovery = false;

  await mkdir(resolve(semanticRoot, "transactions"), { recursive: true });
  await recoverStaleWorkspaceLock(transactionRoot, workspaceLockPath);

  try {
    await acquireWorkspaceLock(workspaceLockPath, {
      version: 1,
      transactionId,
      pid: process.pid,
      command: input.command,
      startedAt: new Date().toISOString(),
      workspaceHash: hashBytes(new TextEncoder().encode(transactionRoot)),
    });
    workspaceLockAcquired = true;
    await input.failureInjector?.("workspace-lock-acquired");
    const transactionsRoot = resolve(semanticRoot, "transactions");
    await recoverTransactionJournals(transactionRoot, transactionsRoot);
    await pruneTerminalTransactionJournals(transactionsRoot);

    const previousOutput = await readOptional(outputPath);
    const previousLock = await readOptional(lockPath);
    if (
      input.expectedLockHash !== undefined &&
      hashOptional(previousLock) !== input.expectedLockHash
    ) {
      throw new Error(
        "semantic transaction conflict: semantic.lock changed after it was read",
      );
    }
    if (input.preserveLock && previousLock === undefined) {
      throw new Error("semantic transaction cannot preserve a missing lock");
    }
    const nextLock =
      input.preserveLock && previousLock !== undefined
        ? previousLock
        : requestedNextLock;

    const timestamp = new Date().toISOString();
    journal = {
      version: 1,
      id: transactionId,
      state: "prepared",
      outputPath: workspacePath(
        transactionRoot,
        outputPath,
        "generated output",
      ),
      lockPath: workspacePath(transactionRoot, lockPath, "semantic lock"),
      previousOutputHash: hashOptional(previousOutput),
      previousLockHash: hashOptional(previousLock),
      nextOutputHash: hashBytes(nextOutput),
      nextLockHash: hashBytes(nextLock),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await mkdir(transactionDirectory);
    await writeSnapshot(
      resolve(transactionDirectory, "previous-output.bin"),
      previousOutput,
    );
    await writeSnapshot(
      resolve(transactionDirectory, "previous-lock.bin"),
      previousLock,
    );
    await writeFile(
      resolve(transactionDirectory, "next-output.bin"),
      nextOutput,
    );
    await writeFile(resolve(transactionDirectory, "next-lock.bin"), nextLock);
    await writeJournal(transactionDirectory, journal);
    await input.failureInjector?.("journal-created");

    await atomicWrite(outputPath, nextOutput);
    journal = await advanceJournal(
      transactionDirectory,
      journal,
      "output-applied",
    );
    await input.failureInjector?.("output-applied");

    await input.runFullTest();
    journal = await advanceJournal(transactionDirectory, journal, "tested");
    await input.failureInjector?.("full-test-passed");

    if (input.preserveLock) {
      // Replay cache hits preserve the exact lock bytes and mtime.
    } else if (input.applyLock === undefined) {
      await atomicWrite(lockPath, nextLock);
    } else {
      await input.applyLock();
    }
    if (hashOptional(await readOptional(lockPath)) !== journal.nextLockHash) {
      throw new Error("semantic transaction lock hash verification failed");
    }
    await input.failureInjector?.("lock-applied");

    if (
      hashOptional(await readOptional(outputPath)) !== journal.nextOutputHash
    ) {
      throw new Error("semantic transaction output hash verification failed");
    }
    journal = await advanceJournal(transactionDirectory, journal, "committed");
    await input.failureInjector?.("committed");
  } catch (error) {
    if (error instanceof SemanticSimulatedCrash) {
      preserveForRecovery = true;
      throw error;
    }
    if (journal !== undefined) {
      try {
        await rollbackTransaction(
          transactionRoot,
          transactionDirectory,
          journal,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "semantic transaction failed and rollback was incomplete",
        );
      }
    }
    throw error;
  } finally {
    if (workspaceLockAcquired && !preserveForRecovery) {
      await unlinkIfExists(workspaceLockPath);
    }
  }
}

export async function recoverSemanticTransactions(
  transactionRootInput: string,
  options: { allowCurrentProcess?: boolean } = {},
): Promise<void> {
  const transactionRoot = resolve(transactionRootInput);
  const semanticRoot = resolve(transactionRoot, ".semantic");
  const workspaceLockPath = resolve(semanticRoot, "workspace.lock");
  const workspaceLock = await readWorkspaceLock(workspaceLockPath);
  if (
    workspaceLock !== null &&
    workspaceLock.workspaceHash !==
      hashBytes(new TextEncoder().encode(transactionRoot))
  ) {
    throw new Error(
      "manual-recovery-required: semantic workspace lock belongs to a different workspace",
    );
  }
  if (
    workspaceLock !== null &&
    isProcessAlive(workspaceLock.pid) &&
    !(options.allowCurrentProcess && workspaceLock.pid === process.pid)
  ) {
    throw new Error(
      `semantic workspace-busy: transaction ${workspaceLock.transactionId} is active`,
    );
  }

  const transactionsRoot = resolve(semanticRoot, "transactions");
  let entries: string[];
  try {
    entries = await readdir(transactionsRoot);
  } catch (error) {
    if (isNotFound(error)) {
      if (workspaceLock !== null) await unlinkIfExists(workspaceLockPath);
      return;
    }
    throw error;
  }

  if (entries.length > 0) {
    await recoverTransactionJournals(transactionRoot, transactionsRoot);
  }

  if (workspaceLock !== null) await unlinkIfExists(workspaceLockPath);
}

export function hashSemanticBytes(value: string | Uint8Array): string {
  return hashBytes(asBytes(value));
}

async function recoverStaleWorkspaceLock(
  transactionRoot: string,
  workspaceLockPath: string,
): Promise<void> {
  const existing = await readWorkspaceLock(workspaceLockPath);
  if (existing === null) return;
  if (isProcessAlive(existing.pid)) {
    throw new Error(
      `semantic workspace-busy: transaction ${existing.transactionId} is active`,
    );
  }
  await recoverSemanticTransactions(transactionRoot);
}

type LocatedTransactionJournal = {
  transactionDirectory: string;
  journal: SemanticTransactionJournal;
};

async function recoverTransactionJournals(
  transactionRoot: string,
  transactionsRoot: string,
): Promise<void> {
  const journals = await readTransactionJournals(transactionsRoot);
  const active = journals.filter(
    ({ journal }) =>
      journal.state !== "committed" && journal.state !== "rolled-back",
  );
  if (active.length > 1) {
    throw new Error(
      "manual-recovery-required: multiple incomplete semantic transactions exist",
    );
  }
  const incomplete = active[0];
  if (incomplete !== undefined) {
    await rollbackTransaction(
      transactionRoot,
      incomplete.transactionDirectory,
      incomplete.journal,
    );
    return;
  }
  if (
    journals.length > 0 &&
    !(await someTerminalJournalMatches(transactionRoot, journals))
  ) {
    throw new Error(
      "manual-recovery-required: no terminal transaction matches the current artifacts",
    );
  }
}

async function readTransactionJournals(
  transactionsRoot: string,
): Promise<LocatedTransactionJournal[]> {
  let entries: string[];
  try {
    entries = await readdir(transactionsRoot);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const journals: LocatedTransactionJournal[] = [];
  for (const entry of entries.sort()) {
    const transactionDirectory = resolve(transactionsRoot, entry);
    try {
      const journal = await readJournal(transactionDirectory);
      if (journal.id !== entry) {
        throw new Error(
          `semantic transaction journal.id must match its directory: ${entry}`,
        );
      }
      journals.push({ transactionDirectory, journal });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
  return journals;
}

async function someTerminalJournalMatches(
  transactionRoot: string,
  journals: LocatedTransactionJournal[],
): Promise<boolean> {
  for (const { journal } of journals) {
    const outputPath = await resolveProtectedPath(
      transactionRoot,
      resolve(transactionRoot, journal.outputPath),
      "transaction output",
    );
    const lockPath = await resolveProtectedPath(
      transactionRoot,
      resolve(transactionRoot, journal.lockPath),
      "transaction lock",
    );
    const expectedOutputHash =
      journal.state === "committed"
        ? journal.nextOutputHash
        : journal.previousOutputHash;
    const expectedLockHash =
      journal.state === "committed"
        ? journal.nextLockHash
        : journal.previousLockHash;
    if (
      hashOptional(await readOptional(outputPath)) === expectedOutputHash &&
      hashOptional(await readOptional(lockPath)) === expectedLockHash
    ) {
      return true;
    }
  }
  return false;
}

async function pruneTerminalTransactionJournals(
  transactionsRoot: string,
): Promise<void> {
  const journals = await readTransactionJournals(transactionsRoot);
  await Promise.all(
    journals
      .filter(
        ({ journal }) =>
          journal.state === "committed" || journal.state === "rolled-back",
      )
      .map(({ transactionDirectory }) =>
        rm(transactionDirectory, { recursive: true }),
      ),
  );
}

async function acquireWorkspaceLock(
  path: string,
  value: WorkspaceLock,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new Error("semantic workspace-busy: another promotion is active");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function rollbackTransaction(
  transactionRoot: string,
  transactionDirectory: string,
  journal: SemanticTransactionJournal,
): Promise<void> {
  const outputPath = await resolveProtectedPath(
    transactionRoot,
    resolve(transactionRoot, journal.outputPath),
    "transaction output",
  );
  const lockPath = await resolveProtectedPath(
    transactionRoot,
    resolve(transactionRoot, journal.lockPath),
    "transaction lock",
  );
  const currentOutputHash = hashOptional(await readOptional(outputPath));
  const currentLockHash = hashOptional(await readOptional(lockPath));
  if (
    !matchesKnownState(
      currentOutputHash,
      journal.previousOutputHash,
      journal.nextOutputHash,
    ) ||
    !matchesKnownState(
      currentLockHash,
      journal.previousLockHash,
      journal.nextLockHash,
    )
  ) {
    throw new Error(
      `manual-recovery-required: transaction ${journal.id} artifacts have unknown hashes`,
    );
  }

  const previousOutput = await readSnapshot(
    resolve(transactionDirectory, "previous-output.bin"),
    journal.previousOutputHash,
  );
  const previousLock = await readSnapshot(
    resolve(transactionDirectory, "previous-lock.bin"),
    journal.previousLockHash,
  );
  await restoreFile(outputPath, previousOutput);
  await restoreFile(lockPath, previousLock);
  if (
    hashOptional(await readOptional(outputPath)) !==
      journal.previousOutputHash ||
    hashOptional(await readOptional(lockPath)) !== journal.previousLockHash
  ) {
    throw new Error(
      `manual-recovery-required: transaction ${journal.id} rollback verification failed`,
    );
  }
  await advanceJournal(transactionDirectory, journal, "rolled-back");
}

async function readSnapshot(
  path: string,
  expectedHash: string | null,
): Promise<Uint8Array | undefined> {
  if (expectedHash === null) return undefined;
  const value = new Uint8Array(await readFile(path));
  if (hashBytes(value) !== expectedHash) {
    throw new Error(
      `manual-recovery-required: snapshot hash mismatch for ${path}`,
    );
  }
  return value;
}

async function writeSnapshot(
  path: string,
  value: Uint8Array | undefined,
): Promise<void> {
  if (value !== undefined) await writeFile(path, value);
}

async function writeJournal(
  transactionDirectory: string,
  journal: SemanticTransactionJournal,
): Promise<void> {
  await atomicWrite(
    resolve(transactionDirectory, "transaction.json"),
    new TextEncoder().encode(`${JSON.stringify(journal, null, 2)}\n`),
  );
}

async function advanceJournal(
  transactionDirectory: string,
  journal: SemanticTransactionJournal,
  state: SemanticTransactionState,
): Promise<SemanticTransactionJournal> {
  const next = { ...journal, state, updatedAt: new Date().toISOString() };
  await writeJournal(transactionDirectory, next);
  return next;
}

async function readJournal(
  transactionDirectory: string,
): Promise<SemanticTransactionJournal> {
  const raw = await readFile(
    resolve(transactionDirectory, "transaction.json"),
    "utf8",
  );
  const value = expectRecord(
    parseBoundedJsonText(raw, "semantic transaction journal"),
    "semantic transaction journal",
  );
  assertKnownKeys(
    value,
    [
      "version",
      "id",
      "state",
      "outputPath",
      "lockPath",
      "previousOutputHash",
      "previousLockHash",
      "nextOutputHash",
      "nextLockHash",
      "createdAt",
      "updatedAt",
    ],
    "semantic transaction journal",
  );
  if (value.version !== 1) {
    throw new Error("semantic transaction journal.version must be 1");
  }
  const state = expectString(value.state, "semantic transaction journal.state");
  if (!isTransactionState(state)) {
    throw new Error(`semantic transaction journal.state is invalid: ${state}`);
  }
  return {
    version: 1,
    id: expectString(value.id, "semantic transaction journal.id"),
    state,
    outputPath: expectRelativePath(
      value.outputPath,
      "semantic transaction journal.outputPath",
    ),
    lockPath: expectRelativePath(
      value.lockPath,
      "semantic transaction journal.lockPath",
    ),
    previousOutputHash: expectOptionalHash(
      value.previousOutputHash,
      "semantic transaction journal.previousOutputHash",
    ),
    previousLockHash: expectOptionalHash(
      value.previousLockHash,
      "semantic transaction journal.previousLockHash",
    ),
    nextOutputHash: expectHash(
      value.nextOutputHash,
      "semantic transaction journal.nextOutputHash",
    ),
    nextLockHash: expectHash(
      value.nextLockHash,
      "semantic transaction journal.nextLockHash",
    ),
    createdAt: expectTimestamp(
      value.createdAt,
      "semantic transaction journal.createdAt",
    ),
    updatedAt: expectTimestamp(
      value.updatedAt,
      "semantic transaction journal.updatedAt",
    ),
  };
}

async function readWorkspaceLock(path: string): Promise<WorkspaceLock | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const value = expectRecord(
    parseBoundedJsonText(raw, "semantic workspace lock"),
    "semantic workspace lock",
  );
  assertKnownKeys(
    value,
    [
      "version",
      "transactionId",
      "pid",
      "command",
      "startedAt",
      "workspaceHash",
    ],
    "semantic workspace lock",
  );
  if (value.version !== 1) {
    throw new Error("semantic workspace lock.version must be 1");
  }
  const command = expectString(
    value.command,
    "semantic workspace lock.command",
  );
  if (command !== "build" && command !== "replay" && command !== "approve") {
    throw new Error("semantic workspace lock.command is invalid");
  }
  if (
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  ) {
    throw new Error(
      "semantic workspace lock.pid must be a positive safe integer",
    );
  }
  return {
    version: 1,
    transactionId: expectString(
      value.transactionId,
      "semantic workspace lock.transactionId",
    ),
    pid: value.pid,
    command,
    startedAt: expectTimestamp(
      value.startedAt,
      "semantic workspace lock.startedAt",
    ),
    workspaceHash: expectHash(
      value.workspaceHash,
      "semantic workspace lock.workspaceHash",
    ),
  };
}

async function resolveProtectedPath(
  rootInput: string,
  pathInput: string,
  label: string,
): Promise<string> {
  const root = resolve(rootInput);
  const path = resolve(pathInput);
  workspacePath(root, path, label);
  const rootReal = await realpath(root);
  const parentReal = await realpath(dirname(path));
  workspacePath(
    rootReal,
    resolve(parentReal, path.slice(dirname(path).length + 1)),
    label,
  );
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link`);
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return path;
}

function workspacePath(root: string, path: string, label: string): string {
  const value = relative(root, path);
  if (
    value.length === 0 ||
    value === ".." ||
    value.startsWith("../") ||
    value.startsWith("..\\") ||
    value.startsWith("/")
  ) {
    throw new Error(`${label} must be a file inside the transaction workspace`);
  }
  return value.replaceAll("\\", "/");
}

async function atomicWrite(path: string, value: Uint8Array): Promise<void> {
  await atomicWriteFile(path, value);
}

async function restoreFile(
  path: string,
  previous: Uint8Array | undefined,
): Promise<void> {
  if (previous === undefined) {
    await unlinkIfExists(path);
  } else {
    await atomicWrite(path, previous);
  }
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashOptional(value: Uint8Array | undefined): string | null {
  return value === undefined ? null : hashBytes(value);
}

function matchesKnownState(
  actual: string | null,
  previous: string | null,
  next: string,
): boolean {
  return actual === previous || actual === next;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function expectHash(value: unknown, path: string): string {
  const hash = expectString(value, path);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${path} must be a SHA-256 hash`);
  }
  return hash;
}

function expectOptionalHash(value: unknown, path: string): string | null {
  return value === null ? null : expectHash(value, path);
}

function expectRelativePath(value: unknown, path: string): string {
  const candidate = expectString(value, path);
  if (
    candidate.startsWith("/") ||
    candidate === ".." ||
    candidate.startsWith("../") ||
    candidate.includes("/../")
  ) {
    throw new Error(`${path} must be workspace-relative`);
  }
  return candidate;
}

function expectTimestamp(value: unknown, path: string): string {
  const timestamp = expectString(value, path);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== timestamp) {
    throw new Error(`${path} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function isTransactionState(value: string): value is SemanticTransactionState {
  return [
    "prepared",
    "output-applied",
    "tested",
    "committed",
    "rolled-back",
  ].includes(value);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
