import { expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runStudy } from "./paper-study";
import { withStudyRunLock } from "./paper-study-lock";

type Child = {
  process: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  exit: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  release: () => void;
  stop: () => Promise<void>;
};
function child(mode: string, dir: string): Child {
  const proc = spawn(
    process.execPath,
    [resolve("src/paper-study-concurrency-child.ts"), mode, dir],
    {
      cwd: resolve("."),
      stdio: "pipe",
    },
  );
  let stdout = "";
  let stderr = "";
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});
  const timeout = setTimeout(() => {
    if (!readySettled) {
      readySettled = true;
      readyReject(new Error(`child ready timeout: ${mode}`));
      proc.kill("SIGKILL");
    }
  }, 30000);
  const exitTimeout = setTimeout(() => {
    proc.kill("SIGKILL");
  }, 60000);
  proc.on("error", (error) => {
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
  });
  proc.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (!readySettled && stdout.includes("READY\n")) {
      readySettled = true;
      clearTimeout(timeout);
      readyResolve();
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(exitTimeout);
      if (!readySettled) {
        readySettled = true;
        readyReject(new Error(`child exited before ready: ${mode}: ${stderr}`));
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
  return {
    process: proc,
    ready,
    exit,
    release: () => {
      proc.stdin.write("GO\n");
    },
    stop: async () => {
      if (proc.exitCode === null && proc.signalCode === null)
        proc.kill("SIGKILL");
      await exit;
    },
  };
}
const lockPath = (dir: string) => resolve(dir, ".paper-study.lock");

test("P5-03 independent Bun processes allow only one lock owner", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "paper-concurrency-lock-"));
  const first = child("lock-hold", dir);
  try {
    await first.ready;
    const second = child("lock-probe", dir);
    try {
      const loser = await second.exit;
      expect(loser.code).toBe(2);
      expect(loser.stderr).toContain("PAPER_STUDY_LOCKED");
      expect(loser.stdout).not.toContain("READY");
    } finally {
      await second.stop();
    }
    first.release();
    expect((await first.exit).code).toBe(0);
    await expect(lstat(lockPath(dir))).rejects.toThrow();
  } finally {
    await first.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("P5-11/17 snapshot publication is inside the lock", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-concurrency-run-"));
  const dir = resolve(root, "run");
  const first = child("run-hold-publish", dir);
  try {
    await first.ready;
    const competingResume = child("resume", dir);
    try {
      const result = await competingResume.exit;
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("PAPER_STUDY_LOCKED");
    } finally {
      await competingResume.stop();
    }
    await expect(
      runStudy(resolve("research/paper-v1/study-draft.json"), "fixture", dir),
    ).rejects.toThrow();
    first.release();
    expect((await first.exit).code).toBe(0);
    expect((await lstat(resolve(dir, "inputs.json"))).isFile()).toBe(true);
    await expect(lstat(lockPath(dir))).rejects.toThrow();
  } finally {
    await first.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-12/13 two resume processes never dispatch the same pending trial", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-concurrency-resume-"));
  const dir = resolve(root, "run");
  let first: Child | null = null;
  try {
    await expect(
      runStudy(
        resolve("research/paper-v1/study-draft.json"),
        "fixture",
        dir,
        undefined,
        {
          initialSaveRun: async (output, run) => {
            await writeFile(resolve(output, "run.json"), JSON.stringify(run));
            throw new Error("stop before dispatch");
          },
        },
      ),
    ).rejects.toThrow("stop before dispatch");
    await expect(lstat(lockPath(dir))).rejects.toThrow();
    first = child("resume-hold", dir);
    await first.ready;
    const competingResume = child("resume", dir);
    try {
      const result = await competingResume.exit;
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("PAPER_STUDY_LOCKED");
    } finally {
      await competingResume.stop();
    }
    first.release();
    expect((await first.exit).code).toBe(0);
    const completed = JSON.parse(
      await readFile(resolve(dir, "run.json"), "utf8"),
    );
    expect(completed.status).toBe("complete");
    expect(
      completed.trials.map((trial: { status: string }) => trial.status),
    ).toEqual(["pass", "pass", "pass", "unresolved"]);
    const before = await readFile(resolve(dir, "logic-1", "run.json"), "utf8");
    const later = child("resume", dir);
    try {
      expect((await later.exit).code).toBe(0);
    } finally {
      await later.stop();
    }
    expect(await readFile(resolve(dir, "logic-1", "run.json"), "utf8")).toBe(
      before,
    );
  } finally {
    if (first) await first.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-16/24 killed owners leave even an incomplete lock and are never stolen", async () => {
  for (const mode of ["lock-hold", "prewrite-hold"]) {
    const dir = await mkdtemp(resolve(tmpdir(), "paper-concurrency-kill-"));
    const holder = child(mode, dir);
    try {
      await holder.ready;
      holder.process.kill("SIGKILL");
      expect((await holder.exit).signal).toBe("SIGKILL");
      expect((await lstat(lockPath(dir))).isFile()).toBe(true);
      await expect(withStudyRunLock(dir, async () => {})).rejects.toMatchObject(
        { code: "PAPER_STUDY_LOCKED" },
      );
    } finally {
      await holder.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }
});
