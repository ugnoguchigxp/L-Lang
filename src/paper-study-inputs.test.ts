import { expect, test } from "bun:test";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createInputSnapshot,
  loadStudyInputs,
  parseInputSnapshot,
  publishInputSnapshot,
  readInputSnapshot,
  verifyInputSnapshotRun,
} from "./paper-study-inputs";
import { contentHash } from "./prompt-source";
import { parseStudyRun } from "./paper-study-validation";
import { parseStudy } from "./paper-study-validation";
import { resumeStudy, runStudy, validateStudy } from "./paper-study";
import { buildPaperReport } from "./paper-report";

const draft = resolve("research/paper-v1/study-draft.json");
type MutableSnapshot = Record<string, unknown> & {
  tasks: Record<string, unknown>[];
  checksum: string;
};
const firstTask = (value: MutableSnapshot) => {
  const task = value.tasks[0];
  if (!task) throw new Error("test task missing");
  return task;
};
const snapshot = async () =>
  createInputSnapshot(await loadStudyInputs(draft), null);
async function copiedStudy(root: string) {
  const study = parseStudy(JSON.parse(await readFile(draft, "utf8")));
  const inputDir = resolve(root, "original-inputs");
  await mkdir(inputDir);
  for (const [index, task] of study.tasks.entries()) {
    for (const kind of ["source", "metadata", "oracle", "fixture"] as const) {
      if (!task[kind]) continue;
      const destination = resolve(inputDir, `${index}-${kind}.json`);
      await cp(resolve("research/paper-v1", task[kind]), destination);
      task[kind] = destination;
    }
  }
  const path = resolve(root, "study.json");
  await writeFile(path, JSON.stringify(study));
  return { path, study, inputDir };
}
const reseal = (value: MutableSnapshot) => {
  const { checksum: _, ...unsigned } = value;
  value.checksum = contentHash(unsigned);
  return value;
};

test("P4-02/03 snapshot is deterministic and rejects unknown fields and malformed hashes", async () => {
  const a = await snapshot();
  const b = await snapshot();
  expect(a).toEqual(b);
  expect(contentHash(a)).toBe(contentHash(b));
  for (const mutate of [
    (x: MutableSnapshot) => {
      x.extra = true;
    },
    (x: MutableSnapshot) => {
      delete x.studyHash;
    },
    (x: MutableSnapshot) => {
      x.version = 2;
    },
    (x: MutableSnapshot) => {
      firstTask(x).extra = true;
    },
  ]) {
    const bad = structuredClone(a) as unknown as MutableSnapshot;
    mutate(bad);
    expect(() => parseInputSnapshot(reseal(bad))).toThrow();
  }
  expect(() => parseInputSnapshot({ ...a, checksum: "bad" })).toThrow();
});

test("P4-04/05/27 task structure and run linkage reject resealed changes", async () => {
  const a = await snapshot();
  for (const mutate of [
    (x: MutableSnapshot) => {
      x.tasks.pop();
    },
    (x: MutableSnapshot) => {
      x.tasks[1] = firstTask(x);
    },
    (x: MutableSnapshot) => {
      x.tasks.push(firstTask(x));
    },
    (x: MutableSnapshot) => {
      const first = firstTask(x);
      const second = x.tasks[1];
      if (!second) throw new Error("test task missing");
      x.tasks[0] = second;
      x.tasks[1] = first;
    },
    (x: MutableSnapshot) => {
      firstTask(x).fixture = null;
    },
  ]) {
    const bad = structuredClone(a) as unknown as MutableSnapshot;
    mutate(bad);
    expect(() => parseInputSnapshot(reseal(bad))).toThrow();
  }
  const root = await mkdtemp(resolve(tmpdir(), "paper-input-link-"));
  try {
    const run = await runStudy(draft, "fixture", resolve(root, "run"));
    if (run.version !== 2) throw new Error("expected v2");
    const stored = await readInputSnapshot(resolve(root, "run"));
    expect(verifyInputSnapshotRun(stored, run).planned).toHaveLength(4);
    const altered = reseal(
      structuredClone(stored) as unknown as MutableSnapshot,
    );
    const fixture = firstTask(altered).fixture;
    if (!fixture || typeof fixture !== "object" || Array.isArray(fixture))
      throw new Error("test fixture missing");
    (fixture as Record<string, unknown>).extra = true;
    reseal(altered);
    expect(() =>
      verifyInputSnapshotRun(parseInputSnapshot(altered), run),
    ).toThrow();
    expect(() => parseStudyRun({ ...run, version: 1 })).toThrow();
    const { inputSnapshotHash: _, ...without } = run;
    expect(() => parseStudyRun(without)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P4-07/13/30 publication never replaces a file and symlinks are rejected", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-input-publish-"));
  try {
    const value = await snapshot();
    const path = resolve(root, "inputs.json");
    await publishInputSnapshot(path, value);
    expect(await readInputSnapshot(root)).toEqual(value);
    await expect(publishInputSnapshot(path, value)).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
    await rm(path);
    await symlink(draft, path);
    await expect(readInputSnapshot(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P4-08/10/11 saved inputs survive original input removal and run relocation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-input-move-"));
  try {
    const { path, study, inputDir } = await copiedStudy(root);
    const runDir = resolve(root, "run");
    const expected = await loadStudyInputs(path);
    const run = await runStudy(path, "fixture", runDir, undefined, {
      afterInputsLoaded: async () => {
        const first = study.tasks[0];
        if (!first) throw new Error("test task missing");
        await writeFile(first.source, "{}");
      },
    });
    expect(run.version).toBe(2);
    expect(run.trials.map((t) => t.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "unresolved",
    ]);
    expect((await readInputSnapshot(runDir)).tasks[0]?.source).toEqual(
      expected.tasks[0]?.value?.source,
    );
    await rm(path);
    await rm(inputDir, { recursive: true });
    const before = await buildPaperReport(runDir);
    expect(before.oraclePass).toBe(3);
    const moved = resolve(root, "moved");
    await cp(runDir, moved, { recursive: true });
    expect(await buildPaperReport(moved)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P4-09/26 changed snapshot before a pending trial stops without dispatch", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-input-change-"));
  try {
    let dispatched = 0;
    const dir = resolve(root, "run");
    await expect(
      runStudy(draft, "fixture", dir, undefined, {
        beforeTrial: async (trial) => {
          if (trial.id === "contact-1") {
            const path = resolve(dir, "inputs.json");
            const saved = JSON.parse(await readFile(path, "utf8"));
            saved.tasks[1].fixture.changed = true;
            await writeFile(path, JSON.stringify(saved));
          }
        },
        developmentObject: async (...args) => {
          dispatched++;
          const { runDevelopmentObject } = await import(
            "./capability-development-cli"
          );
          return runDevelopmentObject(...args);
        },
      }),
    ).rejects.toThrow("input snapshot verification failed before dispatch");
    expect(dispatched).toBe(1);
    const saved = parseStudyRun(
      JSON.parse(await readFile(resolve(dir, "run.json"), "utf8")),
    );
    expect(saved.status).toBe("uncertain");
    expect(saved.trials[1]?.status).toBe("uncertain");
    expect(saved.trials[1]?.reason).toBe(
      "input snapshot verification failed before dispatch",
    );
    await expect(resumeStudy(dir)).rejects.toThrow("uncertain trial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P4-09 first trial snapshot change after initial checkpoint is saved uncertain", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-input-first-change-"));
  try {
    const dir = resolve(root, "run");
    let dispatched = 0;
    await expect(
      runStudy(draft, "fixture", dir, undefined, {
        initialSaveRun: async (output, run) => {
          await writeFile(resolve(output, "run.json"), JSON.stringify(run));
          await writeFile(resolve(output, "inputs.json"), "{}");
        },
        developmentObject: async (...args) => {
          dispatched++;
          const { runDevelopmentObject } = await import(
            "./capability-development-cli"
          );
          return runDevelopmentObject(...args);
        },
      }),
    ).rejects.toThrow("input snapshot verification failed before dispatch");
    expect(dispatched).toBe(0);
    const saved = parseStudyRun(
      JSON.parse(await readFile(resolve(dir, "run.json"), "utf8")),
    );
    expect(saved.status).toBe("uncertain");
    expect(saved.trials[0]?.reason).toBe(
      "input snapshot verification failed before dispatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P4-12 fixture resume uses snapshot after originals disappear", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-input-resume-"));
  try {
    const { path, inputDir } = await copiedStudy(root);
    const dir = resolve(root, "run");
    await expect(
      runStudy(path, "fixture", dir, undefined, {
        initialSaveRun: async (output, run) => {
          await writeFile(resolve(output, "run.json"), JSON.stringify(run));
          throw new Error("stop after initial save");
        },
      }),
    ).rejects.toThrow("stop after initial save");
    await rm(path);
    await rm(inputDir, { recursive: true });
    const resumed = await resumeStudy(dir);
    expect(resumed.status).toBe("complete");
    expect(resumed.trials.map((t) => t.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "unresolved",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P4-30 cleanup failure retains the published snapshot and prevents initial run", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-input-cleanup-"));
  try {
    const dir = resolve(root, "run");
    await expect(
      runStudy(draft, "fixture", dir, undefined, {
        publishInputs: (path, value) =>
          publishInputSnapshot(path, value, {
            link,
            unlink: async () => {
              throw new Error("injected cleanup failure");
            },
          }),
      }),
    ).rejects.toThrow("injected cleanup failure");
    expect(
      parseInputSnapshot(
        JSON.parse(await readFile(resolve(dir, "inputs.json"), "utf8")),
      ),
    ).toEqual(await snapshot());
    await expect(readFile(resolve(dir, "run.json"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P4-18/19 live report uses saved approval while resume checks the original", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-input-live-"));
  try {
    const { path, study } = await copiedStudy(root);
    for (const task of study.tasks) {
      task.review = "reviewed";
      const oracle = JSON.parse(await readFile(task.oracle, "utf8"));
      oracle.review = "reviewed";
      await writeFile(task.oracle, JSON.stringify(oracle));
    }
    study.state = "frozen";
    study.review = "reviewed";
    study.approval = "granted";
    study.unresolved = [];
    study.model = "gpt-5.6-terra";
    study.provider = "codex-sdk";
    study.maxOutputTokens = 1024;
    study.maxTotalTokens = 10000;
    study.maxWallMs = 60000;
    study.budget = 12;
    await writeFile(path, JSON.stringify(study));
    study.frozenHashes = (await validateStudy(path)).hashes;
    await writeFile(path, JSON.stringify(study));
    const validation = await validateStudy(path);
    expect(validation.readyForLive).toBe(true);
    const approvalPath = resolve(root, "approval.json");
    await writeFile(
      approvalPath,
      JSON.stringify({
        studyHash: validation.studyHash,
        scope: "live",
        reviewer: "independent-reviewer",
        record: "approved-test-run",
      }),
    );
    const fixtures = new Map<string, unknown>();
    for (const task of study.tasks) {
      if (!task.fixture) throw new Error("test fixture missing");
      fixtures.set(task.id, JSON.parse(await readFile(task.fixture, "utf8")));
    }
    const dir = resolve(root, "run");
    const run = await runStudy(path, "live", dir, approvalPath, {
      developmentObject: async (source, metadata, output, settings) => {
        expect(settings.mode).toBe("live");
        expect(Object.keys(settings).sort()).toEqual(["config", "mode"]);
        const { runDevelopmentObject } = await import(
          "./capability-development-cli"
        );
        const taskId = (source as { id: string }).id;
        return runDevelopmentObject(source, metadata, output, {
          mode: "fixture",
          fixture: fixtures.get(taskId),
        });
      },
    });
    expect(run.status).toBe("complete");
    await writeFile(approvalPath, "{}");
    expect((await buildPaperReport(dir)).oraclePass).toBe(3);
    await expect(resumeStudy(dir)).rejects.toThrow("live approval changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
