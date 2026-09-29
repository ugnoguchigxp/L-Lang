import { expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { withStudyRunLock, type StudyLockIO } from "./paper-study-lock";
import { resumeStudy, runStudy } from "./paper-study";
import { buildPaperReport } from "./paper-report";

const io: StudyLockIO = { lstat, open, readFile, realpath, stat, unlink };
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const lockPath = (dir: string) => resolve(dir, ".paper-study.lock");

test("P5-01/02/05 one owner runs, competitors stop, separate roots proceed", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-basic-"));
  const other = await mkdtemp(resolve(tmpdir(), "paper-lock-other-"));
  const gate = deferred();
  const ready = deferred();
  try {
    const first = withStudyRunLock(root, async (canonical) => {
      expect(canonical).toBe(await realpath(root));
      const owner = JSON.parse(await readFile(lockPath(root), "utf8"));
      expect(Object.keys(owner).sort()).toEqual([
        "format",
        "ownerToken",
        "pid",
        "version",
      ]);
      ready.release();
      await gate.promise;
      return 42;
    });
    await ready.promise;
    let called = 0;
    await expect(
      withStudyRunLock(root, async () => {
        called++;
      }),
    ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCKED" });
    expect(called).toBe(0);
    expect(await withStudyRunLock(other, async () => "other")).toBe("other");
    gate.release();
    expect(await first).toBe(42);
    await expect(lstat(lockPath(root))).rejects.toThrow();
  } finally {
    gate.release();
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("P5-04 symlink alias resolves to the same lock", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-alias-"));
  const alias = `${root}-alias`;
  const gate = deferred();
  const ready = deferred();
  try {
    await symlink(root, alias);
    const first = withStudyRunLock(root, async () => {
      ready.release();
      await gate.promise;
    });
    await ready.promise;
    await expect(withStudyRunLock(alias, async () => {})).rejects.toMatchObject(
      { code: "PAPER_STUDY_LOCKED" },
    );
    gate.release();
    await first;
  } finally {
    gate.release();
    await rm(alias, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-06/21 existing entries and invalid roots are never repaired", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-existing-"));
  let called = 0;
  const action = async () => {
    called++;
  };
  try {
    for (const value of ["", "not-json"]) {
      await writeFile(lockPath(root), value);
      await expect(withStudyRunLock(root, action)).rejects.toMatchObject({
        code: "PAPER_STUDY_LOCKED",
      });
      expect(await readFile(lockPath(root), "utf8")).toBe(value);
      await unlink(lockPath(root));
    }
    await mkdir(lockPath(root));
    await expect(withStudyRunLock(root, action)).rejects.toMatchObject({
      code: "PAPER_STUDY_LOCKED",
    });
    await rm(lockPath(root), { recursive: true });
    await symlink(resolve(root, "absent"), lockPath(root));
    await expect(withStudyRunLock(root, action)).rejects.toMatchObject({
      code: "PAPER_STUDY_LOCKED",
    });
    await unlink(lockPath(root));
    await expect(
      withStudyRunLock(resolve(root, "absent"), action),
    ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCK_IO" });
    const file = resolve(root, "file");
    await writeFile(file, "x");
    await expect(withStudyRunLock(file, action)).rejects.toMatchObject({
      code: "PAPER_STUDY_LOCK_IO",
    });
    expect(called).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-07/21 acquisition failures close and clean only the owned entry", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-acquire-"));
  try {
    let closed = 0;
    let called = 0;
    const broken: StudyLockIO = {
      ...io,
      open: async (...args) => {
        const handle = await open(...args);
        return {
          stat: handle.stat.bind(handle),
          sync: handle.sync.bind(handle),
          writeFile: async () => {
            throw new Error("write failed");
          },
          close: async () => {
            closed++;
            await handle.close();
          },
        };
      },
    };
    await expect(
      withStudyRunLock(
        root,
        async () => {
          called++;
        },
        broken,
      ),
    ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCK_IO" });
    expect(closed).toBe(1);
    expect(called).toBe(0);
    await expect(lstat(lockPath(root))).rejects.toThrow();
    const failedSync: StudyLockIO = {
      ...io,
      open: async (...args) => {
        const handle = await open(...args);
        return {
          stat: handle.stat.bind(handle),
          sync: async () => {
            throw new Error("sync failed");
          },
          writeFile: handle.writeFile.bind(handle),
          close: async () => {
            closed++;
            await handle.close();
          },
        };
      },
    };
    await expect(
      withStudyRunLock(
        root,
        async () => {
          called++;
        },
        failedSync,
      ),
    ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCK_IO" });
    expect(closed).toBe(2);
    expect(called).toBe(0);
    await expect(lstat(lockPath(root))).rejects.toThrow();
    const missingIdentity: StudyLockIO = {
      ...io,
      open: async (...args) => {
        const handle = await open(...args);
        return {
          stat: async () => {
            throw new Error("stat failed");
          },
          sync: handle.sync.bind(handle),
          writeFile: handle.writeFile.bind(handle),
          close: async () => {
            closed++;
            await handle.close();
          },
        };
      },
    };
    await expect(
      withStudyRunLock(
        root,
        async () => {
          called++;
        },
        missingIdentity,
      ),
    ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCK_IO" });
    expect(closed).toBe(3);
    expect(called).toBe(0);
    expect((await lstat(lockPath(root))).isFile()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-08/09 action error is preserved; changed token or inode is never removed", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-owner-"));
  try {
    const failure = new Error("action failed");
    await expect(
      withStudyRunLock(root, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(lstat(lockPath(root))).rejects.toThrow();
    await expect(
      withStudyRunLock(root, async () => {
        const owner = JSON.parse(await readFile(lockPath(root), "utf8"));
        owner.ownerToken = "00000000-0000-4000-8000-000000000000";
        await writeFile(lockPath(root), JSON.stringify(owner));
      }),
    ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCK_RELEASE_FAILED" });
    expect((await lstat(lockPath(root))).isFile()).toBe(true);
    await unlink(lockPath(root));
    await expect(
      withStudyRunLock(root, async () => {
        await unlink(lockPath(root));
        await writeFile(lockPath(root), "replacement");
      }),
    ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCK_RELEASE_FAILED" });
    expect(await readFile(lockPath(root), "utf8")).toBe("replacement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized owner records fail release without reading or deleting them", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-large-owner-"));
  let reads = 0;
  const guardedIO: StudyLockIO = {
    ...io,
    readFile: ((...args: Parameters<typeof readFile>) => {
      reads++;
      return readFile(...args);
    }) as typeof readFile,
  };
  try {
    await expect(
      withStudyRunLock(
        root,
        async () => {
          await writeFile(lockPath(root), "x".repeat(1025));
        },
        guardedIO,
      ),
    ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCK_RELEASE_FAILED" });
    expect(reads).toBe(1);
    expect((await lstat(lockPath(root))).size).toBe(1025);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-10/22 release failures retain both causes and do not recreate a removed lock", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-release-"));
  try {
    const failedUnlink: StudyLockIO = {
      ...io,
      unlink: async () => {
        throw new Error("unlink failed");
      },
    };
    const actionError = new Error("action failed");
    try {
      await withStudyRunLock(
        root,
        async () => {
          throw actionError;
        },
        failedUnlink,
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "PAPER_STUDY_LOCK_RELEASE_FAILED" });
      expect(
        (error as Error & { cause: { actionError: unknown } }).cause
          .actionError,
      ).toBe(actionError);
    }
    await unlink(lockPath(root));
    const failedClose: StudyLockIO = {
      ...io,
      open: async (...args) => {
        const handle = await open(...args);
        return {
          stat: handle.stat.bind(handle),
          sync: handle.sync.bind(handle),
          writeFile: handle.writeFile.bind(handle),
          close: async () => {
            await handle.close();
            throw new Error("close failed");
          },
        };
      },
    };
    await expect(
      withStudyRunLock(root, async () => "complete", failedClose),
    ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCK_RELEASE_FAILED" });
    await expect(lstat(lockPath(root))).rejects.toThrow();
    expect(await withStudyRunLock(root, async () => "later")).toBe("later");
    const racedClose: StudyLockIO = {
      ...io,
      open: async (...args) => {
        const handle = await open(...args);
        return {
          stat: handle.stat.bind(handle),
          sync: handle.sync.bind(handle),
          writeFile: handle.writeFile.bind(handle),
          close: async () => {
            await handle.close();
            const next = await open(lockPath(root), "wx", 0o600);
            await next.writeFile("next owner");
            await next.close();
            throw new Error("close failed after next acquisition");
          },
        };
      },
    };
    await expect(
      withStudyRunLock(root, async () => "complete", racedClose),
    ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCK_RELEASE_FAILED" });
    expect(await readFile(lockPath(root), "utf8")).toBe("next owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-14/19 uncertain and initial checkpoint failure both release the lock", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-run-errors-"));
  const draft = resolve("research/paper-v1/study-draft.json");
  try {
    const first = resolve(root, "initial-failure");
    await expect(
      runStudy(draft, "fixture", first, undefined, {
        initialSaveRun: async () => {
          throw new Error("initial save failed");
        },
      }),
    ).rejects.toThrow("initial save failed");
    await expect(lstat(lockPath(first))).rejects.toThrow();
    expect((await lstat(resolve(first, "inputs.json"))).isFile()).toBe(true);
    const uncertain = resolve(root, "uncertain");
    await expect(
      runStudy(draft, "fixture", uncertain, undefined, {
        beforeTrial: async () => {
          await writeFile(resolve(uncertain, "inputs.json"), "{}");
        },
      }),
    ).rejects.toThrow("input snapshot verification failed before dispatch");
    await expect(lstat(lockPath(uncertain))).rejects.toThrow();
    await expect(resumeStudy(uncertain)).rejects.toThrow("uncertain trial");
    await expect(lstat(lockPath(uncertain))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-14 Oracle failure returns uncertain and releases the lock", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-oracle-"));
  const dir = resolve(root, "run");
  try {
    const run = await runStudy(
      resolve("research/paper-v1/study-draft.json"),
      "fixture",
      dir,
      undefined,
      {
        instantiate: async () => {
          throw new Error("injected Oracle failure");
        },
      },
    );
    expect(run.status).toBe("uncertain");
    await expect(lstat(lockPath(dir))).rejects.toThrow();
    await expect(resumeStudy(dir)).rejects.toThrow("uncertain trial");
    await expect(lstat(lockPath(dir))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-15/18 v1 and v2 resume take the lock; report remains read only", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-compat-"));
  const draft = resolve("research/paper-v1/study-draft.json");
  try {
    const dir = resolve(root, "run");
    const run = await runStudy(draft, "fixture", dir);
    expect(run.version).toBe(2);
    await withStudyRunLock(dir, async () => {
      expect((await buildPaperReport(dir)).evidenceEligible).toBe(false);
      await expect(resumeStudy(dir)).rejects.toMatchObject({
        code: "PAPER_STUDY_LOCKED",
      });
    });
    expect((await resumeStudy(dir)).status).toBe("complete");
    const legacy = { ...run, version: 1 } as Record<string, unknown>;
    delete legacy.inputSnapshotHash;
    await writeFile(resolve(dir, "run.json"), JSON.stringify(legacy));
    expect((await resumeStudy(dir)).version).toBe(1);
    await expect(lstat(lockPath(dir))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-23 resume between mkdir and acquisition sees no run and releases its lock", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-lock-mkdir-race-"));
  const dir = resolve(root, "run");
  try {
    const run = await runStudy(
      resolve("research/paper-v1/study-draft.json"),
      "fixture",
      dir,
      undefined,
      {
        afterOutputCreated: async () => {
          await expect(resumeStudy(dir)).rejects.toThrow();
          await expect(lstat(lockPath(dir))).rejects.toThrow();
        },
      },
    );
    expect(run.status).toBe("complete");
    await expect(lstat(lockPath(dir))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
