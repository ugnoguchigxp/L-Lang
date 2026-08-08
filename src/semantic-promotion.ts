import { serializeSemanticLock } from "./semantic-lock";
import type { SemanticLock, writeSemanticLock } from "./semantic-lock";
import {
  executeSemanticTransaction,
  type SemanticTransactionCommand,
  type SemanticTransactionFailurePoint,
} from "./semantic-transaction";

export async function promoteSemanticArtifact(input: {
  outputPath: string;
  generatedCode: string;
  lockPath: string;
  nextLock: SemanticLock;
  runFullTest: () => Promise<void>;
  writeLock?: typeof writeSemanticLock;
  expectedLockHash?: string | null;
  command?: SemanticTransactionCommand;
  transactionRoot?: string;
  failureInjector?: (
    point: SemanticTransactionFailurePoint,
  ) => void | Promise<void>;
  persistLock?: boolean;
}): Promise<void> {
  const persistLock = input.persistLock ?? true;
  const writeLock = input.writeLock;
  await executeSemanticTransaction({
    ...(input.transactionRoot === undefined
      ? {}
      : { transactionRoot: input.transactionRoot }),
    outputPath: input.outputPath,
    nextOutput: input.generatedCode,
    lockPath: input.lockPath,
    nextLock: serializeSemanticLock(input.nextLock),
    ...(input.expectedLockHash === undefined
      ? {}
      : { expectedLockHash: input.expectedLockHash }),
    command: input.command ?? "build",
    runFullTest: input.runFullTest,
    ...(!persistLock
      ? { preserveLock: true }
      : writeLock === undefined
        ? {}
        : {
            applyLock: () => writeLock(input.lockPath, input.nextLock),
          }),
    ...(input.failureInjector === undefined
      ? {}
      : { failureInjector: input.failureInjector }),
  });
}
