import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  executeSemanticTransaction,
  hashSemanticBytes,
  recoverSemanticTransactions,
  SemanticSimulatedCrash,
  type SemanticTransactionFailurePoint,
} from "./semantic-transaction";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("crash-consistent semantic transaction", () => {
  test("commits both artifacts and records a committed journal", async () => {
    const fixture = await createFixture();

    await executeSemanticTransaction({
      ...fixture,
      command: "build",
      runFullTest: async () => {
        expect(await readFile(fixture.outputPath, "utf8")).toBe(
          "next output\n",
        );
        expect(await readFile(fixture.lockPath, "utf8")).toBe(
          "previous lock\n",
        );
      },
    });

    expect(await readFile(fixture.outputPath, "utf8")).toBe("next output\n");
    expect(await readFile(fixture.lockPath, "utf8")).toBe("next lock\n");
    expect(await latestJournalState(fixture.transactionRoot)).toBe("committed");
    expect(
      await exists(
        resolve(fixture.transactionRoot, ".semantic/workspace.lock"),
      ),
    ).toBeFalse();
  });

  test.each([
    "workspace-lock-acquired",
    "journal-created",
    "output-applied",
    "full-test-passed",
    "lock-applied",
    "committed",
  ] satisfies SemanticTransactionFailurePoint[])(
    "rolls back ordinary failure at %s",
    async (point) => {
      const fixture = await createFixture();
      await expect(
        executeSemanticTransaction({
          ...fixture,
          command: "approve",
          runFullTest: async () => {},
          failureInjector: (current) => {
            if (current === point) throw new Error(`failure at ${point}`);
          },
        }),
      ).rejects.toThrow(`failure at ${point}`);
      expect(await readFile(fixture.outputPath, "utf8")).toBe(
        "previous output\n",
      );
      expect(await readFile(fixture.lockPath, "utf8")).toBe("previous lock\n");
      expect(
        await exists(
          resolve(fixture.transactionRoot, ".semantic/workspace.lock"),
        ),
      ).toBeFalse();
    },
  );

  test("recovers an interrupted output application to the previous state", async () => {
    const fixture = await createFixture();

    await expect(
      executeSemanticTransaction({
        ...fixture,
        command: "replay",
        runFullTest: async () => {},
        failureInjector: (point) => {
          if (point === "output-applied")
            throw new SemanticSimulatedCrash(point);
        },
      }),
    ).rejects.toBeInstanceOf(SemanticSimulatedCrash);
    expect(await readFile(fixture.outputPath, "utf8")).toBe("next output\n");
    expect(await readFile(fixture.lockPath, "utf8")).toBe("previous lock\n");

    await recoverSemanticTransactions(fixture.transactionRoot, {
      allowCurrentProcess: true,
    });

    expect(await readFile(fixture.outputPath, "utf8")).toBe(
      "previous output\n",
    );
    expect(await readFile(fixture.lockPath, "utf8")).toBe("previous lock\n");
    expect(await latestJournalState(fixture.transactionRoot)).toBe(
      "rolled-back",
    );
    expect(
      await exists(
        resolve(fixture.transactionRoot, ".semantic/workspace.lock"),
      ),
    ).toBeFalse();
  });

  test("keeps a committed state when interrupted after the commit marker", async () => {
    const fixture = await createFixture();
    await expect(
      executeSemanticTransaction({
        ...fixture,
        command: "build",
        runFullTest: async () => {},
        failureInjector: (point) => {
          if (point === "committed") throw new SemanticSimulatedCrash(point);
        },
      }),
    ).rejects.toBeInstanceOf(SemanticSimulatedCrash);

    await recoverSemanticTransactions(fixture.transactionRoot, {
      allowCurrentProcess: true,
    });

    expect(await readFile(fixture.outputPath, "utf8")).toBe("next output\n");
    expect(await readFile(fixture.lockPath, "utf8")).toBe("next lock\n");
    expect(await latestJournalState(fixture.transactionRoot)).toBe("committed");
  });

  test("recovers the latest state after sequential successful transactions", async () => {
    const fixture = await createFixture();
    await executeSemanticTransaction({
      ...fixture,
      command: "build",
      runFullTest: async () => {},
    });
    await executeSemanticTransaction({
      ...fixture,
      nextOutput: "second output\n",
      nextLock: "second lock\n",
      command: "build",
      runFullTest: async () => {},
    });

    await recoverSemanticTransactions(fixture.transactionRoot);

    expect(await readFile(fixture.outputPath, "utf8")).toBe("second output\n");
    expect(await readFile(fixture.lockPath, "utf8")).toBe("second lock\n");
  });

  test("blocks automatic recovery when an artifact has an unknown hash", async () => {
    const fixture = await createFixture();
    await expect(
      executeSemanticTransaction({
        ...fixture,
        command: "build",
        runFullTest: async () => {},
        failureInjector: (point) => {
          if (point === "output-applied")
            throw new SemanticSimulatedCrash(point);
        },
      }),
    ).rejects.toBeInstanceOf(SemanticSimulatedCrash);
    await writeFile(fixture.outputPath, "external mutation\n", "utf8");

    await expect(
      recoverSemanticTransactions(fixture.transactionRoot, {
        allowCurrentProcess: true,
      }),
    ).rejects.toThrow("manual-recovery-required");
  });

  test("fails fast for a concurrent promotion and preserves the winner", async () => {
    const fixture = await createFixture();
    let release!: () => void;
    let reached!: () => void;
    const fullTestReached = new Promise<void>((resolveReached) => {
      reached = resolveReached;
    });
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const first = executeSemanticTransaction({
      ...fixture,
      command: "build",
      runFullTest: async () => {
        reached();
        await gate;
      },
    });
    await fullTestReached;

    await expect(
      executeSemanticTransaction({
        ...fixture,
        nextOutput: "losing output\n",
        nextLock: "losing lock\n",
        command: "approve",
        runFullTest: async () => {},
      }),
    ).rejects.toThrow("workspace-busy");
    release();
    await first;

    expect(await readFile(fixture.outputPath, "utf8")).toBe("next output\n");
    expect(await readFile(fixture.lockPath, "utf8")).toBe("next lock\n");
  });

  test("detects an optimistic lock conflict before mutating artifacts", async () => {
    const fixture = await createFixture();
    await expect(
      executeSemanticTransaction({
        ...fixture,
        expectedLockHash: hashSemanticBytes("different lock\n"),
        command: "approve",
        runFullTest: async () => {},
      }),
    ).rejects.toThrow("semantic transaction conflict");

    expect(await readFile(fixture.outputPath, "utf8")).toBe(
      "previous output\n",
    );
    expect(await readFile(fixture.lockPath, "utf8")).toBe("previous lock\n");
  });

  test("preserves exact lock bytes for replay cache hits", async () => {
    const fixture = await createFixture();
    await executeSemanticTransaction({
      ...fixture,
      nextLock: "must not be written\n",
      preserveLock: true,
      command: "replay",
      runFullTest: async () => {},
    });
    expect(await readFile(fixture.lockPath, "utf8")).toBe("previous lock\n");

    const missing = await createFixture();
    await unlink(missing.lockPath);
    await expect(
      executeSemanticTransaction({
        ...missing,
        preserveLock: true,
        command: "replay",
        runFullTest: async () => {},
      }),
    ).rejects.toThrow("cannot preserve a missing lock");
  });

  test("reports an aggregate failure when rollback finds an external mutation", async () => {
    const fixture = await createFixture();
    await expect(
      executeSemanticTransaction({
        ...fixture,
        command: "build",
        runFullTest: async () => {
          await writeFile(fixture.outputPath, "external mutation\n", "utf8");
        },
      }),
    ).rejects.toBeInstanceOf(AggregateError);
  });

  test("rejects recovery while the recorded process is still active", async () => {
    const fixture = await createFixture();
    await expect(
      executeSemanticTransaction({
        ...fixture,
        command: "build",
        runFullTest: async () => {},
        failureInjector: (point) => {
          if (point === "output-applied")
            throw new SemanticSimulatedCrash(point);
        },
      }),
    ).rejects.toBeInstanceOf(SemanticSimulatedCrash);

    await expect(
      recoverSemanticTransactions(fixture.transactionRoot),
    ).rejects.toThrow("workspace-busy");
  });

  test("cleans a stale workspace lock when no journal exists", async () => {
    const fixture = await createFixture();
    const semanticRoot = resolve(fixture.transactionRoot, ".semantic");
    await mkdir(semanticRoot, { recursive: true });
    const workspaceLockPath = resolve(semanticRoot, "workspace.lock");
    await writeFile(
      workspaceLockPath,
      JSON.stringify({
        version: 1,
        transactionId: "stale",
        pid: 99_999_999,
        command: "build",
        startedAt: new Date().toISOString(),
        workspaceHash: hashSemanticBytes(fixture.transactionRoot),
      }),
      "utf8",
    );

    await recoverSemanticTransactions(fixture.transactionRoot);
    expect(await exists(workspaceLockPath)).toBeFalse();
  });

  test("rejects malformed workspace locks and journals", async () => {
    for (const workspaceLock of [
      { version: 2, command: "build", pid: process.pid },
      { version: 1, command: "invalid", pid: process.pid },
      { version: 1, command: "build", pid: 0 },
      {
        version: 1,
        command: "build",
        pid: 99_999_999,
        workspaceHash: hashSemanticBytes("different-workspace"),
      },
    ]) {
      const fixture = await createFixture();
      const semanticRoot = resolve(fixture.transactionRoot, ".semantic");
      await mkdir(semanticRoot, { recursive: true });
      await writeFile(
        resolve(semanticRoot, "workspace.lock"),
        JSON.stringify({
          transactionId: "invalid",
          startedAt: new Date().toISOString(),
          workspaceHash: hashSemanticBytes(fixture.transactionRoot),
          ...workspaceLock,
        }),
        "utf8",
      );
      await expect(
        recoverSemanticTransactions(fixture.transactionRoot),
      ).rejects.toThrow();
    }

    for (const mutate of [
      (journal: Record<string, unknown>) => {
        journal.version = 2;
      },
      (journal: Record<string, unknown>) => {
        journal.state = "unknown";
      },
      (journal: Record<string, unknown>) => {
        journal.outputPath = "../escape";
      },
      (journal: Record<string, unknown>) => {
        journal.nextLockHash = "invalid";
      },
      (journal: Record<string, unknown>) => {
        journal.updatedAt = "yesterday";
      },
      (journal: Record<string, unknown>) => {
        journal.id = "different-directory";
      },
    ]) {
      const fixture = await interruptedFixture("output-applied");
      const journalPath = await latestJournalPath(fixture.transactionRoot);
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<
        string,
        unknown
      >;
      mutate(journal);
      await writeFile(journalPath, JSON.stringify(journal), "utf8");
      await expect(
        recoverSemanticTransactions(fixture.transactionRoot, {
          allowCurrentProcess: true,
        }),
      ).rejects.toThrow();
    }
  });

  test("rejects committed drift and corrupted rollback snapshots", async () => {
    const committed = await interruptedFixture("committed");
    await writeFile(committed.lockPath, "external mutation\n", "utf8");
    await expect(
      recoverSemanticTransactions(committed.transactionRoot, {
        allowCurrentProcess: true,
      }),
    ).rejects.toThrow("manual-recovery-required");

    const rolledBack = await interruptedFixture("output-applied");
    const journalPath = await latestJournalPath(rolledBack.transactionRoot);
    await writeFile(
      resolve(journalPath, "../previous-output.bin"),
      "corrupt snapshot\n",
      "utf8",
    );
    await expect(
      recoverSemanticTransactions(rolledBack.transactionRoot, {
        allowCurrentProcess: true,
      }),
    ).rejects.toThrow("snapshot hash mismatch");
  });

  test("rejects workspace escapes and symbolic-link artifacts", async () => {
    const escaped = await createFixture();
    await expect(
      executeSemanticTransaction({
        ...escaped,
        outputPath: resolve(escaped.transactionRoot, "../escaped-output.ts"),
        command: "build",
        runFullTest: async () => {},
      }),
    ).rejects.toThrow("inside the transaction workspace");

    const linked = await createFixture();
    const target = resolve(linked.transactionRoot, "target.ts");
    await writeFile(target, "target\n", "utf8");
    await unlink(linked.outputPath);
    await symlink(target, linked.outputPath);
    await expect(
      executeSemanticTransaction({
        ...linked,
        command: "build",
        runFullTest: async () => {},
      }),
    ).rejects.toThrow("symbolic link");
  });

  test("rolls back to absent output and lock snapshots", async () => {
    const fixture = await createFixture();
    await unlink(fixture.outputPath);
    await unlink(fixture.lockPath);
    await expect(
      executeSemanticTransaction({
        ...fixture,
        command: "build",
        runFullTest: async () => {
          throw new Error("validation failure");
        },
      }),
    ).rejects.toThrow("validation failure");
    expect(await exists(fixture.outputPath)).toBeFalse();
    expect(await exists(fixture.lockPath)).toBeFalse();
  });
});

async function createFixture() {
  const transactionRoot = await mkdtemp(
    resolve(tmpdir(), "semantic-transaction-"),
  );
  temporaryRoots.push(transactionRoot);
  const outputPath = resolve(transactionRoot, "generated.ts");
  const lockPath = resolve(transactionRoot, "semantic.lock");
  await writeFile(outputPath, "previous output\n", "utf8");
  await writeFile(lockPath, "previous lock\n", "utf8");
  return {
    transactionRoot,
    outputPath,
    lockPath,
    nextOutput: "next output\n",
    nextLock: "next lock\n",
  };
}

async function latestJournalState(root: string): Promise<string> {
  const journalPath = await latestJournalPath(root);
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    state: string;
  };
  return journal.state;
}

async function latestJournalPath(root: string): Promise<string> {
  const transactions = resolve(root, ".semantic/transactions");
  const entries = (await readdir(transactions)).sort();
  const latest = entries.at(-1);
  if (latest === undefined) throw new Error("transaction journal missing");
  return resolve(transactions, latest, "transaction.json");
}

async function interruptedFixture(
  point: SemanticTransactionFailurePoint,
): Promise<Awaited<ReturnType<typeof createFixture>>> {
  const fixture = await createFixture();
  await expect(
    executeSemanticTransaction({
      ...fixture,
      command: "build",
      runFullTest: async () => {},
      failureInjector: (current) => {
        if (current === point) throw new SemanticSimulatedCrash(point);
      },
    }),
  ).rejects.toBeInstanceOf(SemanticSimulatedCrash);
  return fixture;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
