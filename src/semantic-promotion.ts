import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

import {
  writeSemanticLock,
  type SemanticLock,
} from "./semantic-lock";

export async function promoteSemanticArtifact(input: {
  outputPath: string;
  generatedCode: string;
  lockPath: string;
  nextLock: SemanticLock;
  runFullTest: () => Promise<void>;
  writeLock?: typeof writeSemanticLock;
}): Promise<void> {
  const previousOutput = await readOptional(input.outputPath);
  const previousLock = await readOptional(input.lockPath);
  let outputApplied = false;
  let lockWriteAttempted = false;

  try {
    await atomicWrite(input.outputPath, input.generatedCode);
    outputApplied = true;
    await input.runFullTest();
    lockWriteAttempted = true;
    await (input.writeLock ?? writeSemanticLock)(input.lockPath, input.nextLock);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (lockWriteAttempted) {
      try {
        await restoreFile(input.lockPath, previousLock);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (outputApplied) {
      try {
        await restoreFile(input.outputPath, previousOutput);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "semantic promotion failed and rollback was incomplete",
      );
    }
    throw error;
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.promote.tmp`;
  try {
    await writeFile(temporary, value, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await unlinkIfExists(temporary);
    throw error;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function restoreFile(
  path: string,
  previous: string | undefined,
): Promise<void> {
  if (previous === undefined) {
    await unlinkIfExists(path);
    return;
  }
  await atomicWrite(path, previous);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
