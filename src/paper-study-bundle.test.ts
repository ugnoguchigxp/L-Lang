import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
  open,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runPaperCli } from "./paper-cli";
import { savePaperReport } from "./paper-report";
import {
  createStudyBundle,
  parseStudyBundleManifest,
  verifyStudyBundle,
} from "./paper-study-bundle";
import { withStudyRunLock, type StudyLockIO } from "./paper-study-lock";
import { resumeStudy, runStudy, validateStudy } from "./paper-study";
import { contentHash } from "./prompt-source";

const draft = resolve("research/paper-v1/study-draft.json");
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "paper-bundle-test-"));
  const run = resolve(root, "run");
  const bundle = resolve(root, "bundle");
  await runStudy(draft, "fixture", run);
  return {
    root,
    run,
    bundle,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
async function reseal(
  bundle: string,
  edit: (value: Record<string, unknown>) => void,
) {
  const path = resolve(bundle, "bundle.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  edit(value);
  const { checksum: _, ...body } = value;
  value.checksum = contentHash(body);
  await writeFile(path, JSON.stringify(value));
}

test("P6-01/02/20 complete fixture copies every byte and is deterministic", async () => {
  const f = await fixture();
  try {
    const first = await createStudyBundle(f.run, f.bundle);
    const second = await createStudyBundle(f.run, resolve(f.root, "second"));
    expect(first.bundleHash).toBe(second.bundleHash);
    expect(first.report.plannedTrials).toBe(4);
    expect(first.report.counts).toMatchObject({ pass: 3, unresolved: 1 });
    expect(first.report.oraclePass).toBe(3);
    expect(first.evidenceEligible).toBe(false);
    const manifest = parseStudyBundleManifest(
      JSON.parse(await readFile(resolve(f.bundle, "bundle.json"), "utf8")),
    );
    expect(manifest.files.length).toBe(first.fileCount);
    expect(manifest.files.some((file) => file.path.includes("attempt-0"))).toBe(
      true,
    );
    expect(
      manifest.files.some((file) => file.path === ".paper-study.lock"),
    ).toBe(false);
    for (const file of manifest.files) {
      const original = await readFile(resolve(f.run, file.path));
      const copied = await readFile(resolve(f.bundle, "evidence", file.path));
      expect(copied.equals(original)).toBe(true);
      expect(digest(copied)).toBe(file.sha256);
      expect(
        (await lstat(resolve(f.bundle, "evidence", file.path))).mode & 0o777,
      ).toBe(0o600);
    }
    expect((await lstat(f.bundle)).mode & 0o777).toBe(0o700);
  } finally {
    await f.cleanup();
  }
});

test("P6-03 moved bundle verifies without original and reports outside", async () => {
  const f = await fixture();
  try {
    await createStudyBundle(f.run, f.bundle);
    const moved = resolve(f.root, "moved");
    await rename(f.bundle, moved);
    await rm(f.run, { recursive: true });
    const before = await readFile(resolve(moved, "bundle.json"));
    expect((await verifyStudyBundle(moved)).report.oraclePass).toBe(3);
    expect(
      (
        await savePaperReport(
          resolve(moved, "evidence"),
          resolve(f.root, "report"),
        )
      ).summary.evidenceEligible,
    ).toBe(false);
    expect(await readFile(resolve(moved, "bundle.json"))).toEqual(before);
  } finally {
    await f.cleanup();
  }
});

test("P6-04/05 byte changes and file set changes fail closed", async () => {
  const f = await fixture();
  try {
    await createStudyBundle(f.run, f.bundle);
    const runFile = resolve(f.bundle, "evidence", "run.json");
    await writeFile(runFile, `${await readFile(runFile, "utf8")} `);
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow(
      "byte hash mismatch",
    );
    await copyFile(resolve(f.run, "run.json"), runFile);
    const manifest = parseStudyBundleManifest(
      JSON.parse(await readFile(resolve(f.bundle, "bundle.json"), "utf8")),
    );
    const wasm = manifest.files.find((item) => item.path.endsWith(".wasm"));
    expect(wasm).toBeDefined();
    if (!wasm) throw new Error("fixture Wasm missing");
    const wasmPath = resolve(f.bundle, "evidence", wasm.path);
    const original = await readFile(wasmPath);
    const altered = Buffer.from(original);
    altered[0] = (altered[0] ?? 0) ^ 1;
    await writeFile(wasmPath, altered);
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow(
      "byte hash mismatch",
    );
    await writeFile(wasmPath, original);
    await writeFile(resolve(f.bundle, "evidence", "extra.json"), "{}");
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow("file set");
    await unlink(resolve(f.bundle, "evidence", "extra.json"));
    await unlink(runFile);
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow("file set");
  } finally {
    await f.cleanup();
  }
});

test("P6-05/06/07 manifest rejects malformed fields, paths and ordering", async () => {
  const f = await fixture();
  try {
    await createStudyBundle(f.run, f.bundle);
    const original = JSON.parse(
      await readFile(resolve(f.bundle, "bundle.json"), "utf8"),
    );
    const invalid = [
      (m: typeof original) => {
        m.unexpected = true;
      },
      (m: typeof original) => {
        m.files[0].sha256 = "A".repeat(64);
      },
      (m: typeof original) => {
        m.files.push(m.files[0]);
      },
      (m: typeof original) => {
        m.files.reverse();
      },
      ...[
        "/absolute",
        "C:/drive",
        "a\\b",
        "a//b",
        "a/./b",
        "a/../b",
        "a\0b",
      ].map((path) => (m: typeof original) => {
        m.files[0].path = path;
      }),
    ];
    for (const change of invalid) {
      const manifest = structuredClone(original);
      change(manifest);
      expect(() => parseStudyBundleManifest(manifest)).toThrow();
    }
    const broken = structuredClone(original);
    broken.checksum = "0".repeat(64);
    expect(() => parseStudyBundleManifest(broken)).toThrow();
    const symlinkPath = resolve(f.bundle, "evidence", "linked");
    await symlink(resolve(f.bundle, "evidence", "run.json"), symlinkPath);
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow(
      "symlink or special",
    );
    await unlink(symlinkPath);
    await mkdir(resolve(f.bundle, "evidence", "empty"));
    await symlink(
      resolve(f.run, "run.json"),
      resolve(f.bundle, "evidence", "empty", "linked"),
    );
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow(
      "symlink or special",
    );
  } finally {
    await f.cleanup();
  }
});

test("P6-08/09 resealed linkage and unfinished runs are rejected", async () => {
  const f = await fixture();
  try {
    await createStudyBundle(f.run, f.bundle);
    await reseal(f.bundle, (m) => {
      m.runHash = "0".repeat(64);
    });
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow(
      "linkage mismatch",
    );
    for (const change of [
      (run: Record<string, unknown>) => {
        run.version = 1;
        delete run.inputSnapshotHash;
      },
      (run: Record<string, unknown>) => {
        run.status = "running";
      },
      (run: Record<string, unknown>) => {
        run.status = "uncertain";
      },
      (run: Record<string, unknown>) => {
        (run.trials as unknown[]).pop();
      },
    ]) {
      const run = JSON.parse(
        await readFile(resolve(f.run, "run.json"), "utf8"),
      );
      change(run);
      await writeFile(resolve(f.run, "run.json"), JSON.stringify(run));
      await expect(
        createStudyBundle(f.run, resolve(f.root, `bad-${Math.random()}`)),
      ).rejects.toThrow();
      await copyFile(
        resolve(f.bundle, "evidence", "run.json"),
        resolve(f.run, "run.json"),
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("P6-08 resealed changed run and Oracle sidecar still fail record linkage", async () => {
  const f = await fixture();
  try {
    await createStudyBundle(f.run, f.bundle);
    const runPath = resolve(f.bundle, "evidence", "run.json");
    const originalRun = await readFile(runPath);
    const run = JSON.parse(originalRun.toString());
    run.studyHash = "0".repeat(64);
    await writeFile(runPath, JSON.stringify(run));
    await reseal(f.bundle, (m) => {
      m.runHash = contentHash(run);
      const item = (
        m.files as { path: string; bytes: number; sha256: string }[]
      ).find((x) => x.path === "run.json");
      if (!item) throw new Error("run entry missing");
      const bytes = Buffer.from(JSON.stringify(run));
      item.bytes = bytes.length;
      item.sha256 = digest(bytes);
    });
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow();
    await writeFile(runPath, originalRun);
    await copyFile(
      resolve(f.run, "logic-1", "oracle-evidence.json"),
      resolve(f.bundle, "evidence", "logic-1", "oracle-evidence.json"),
    );
    const sidecarPath = resolve(
      f.bundle,
      "evidence",
      "logic-1",
      "oracle-evidence.json",
    );
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    sidecar.studyHash = "0".repeat(64);
    const bytes = Buffer.from(JSON.stringify(sidecar));
    await writeFile(sidecarPath, bytes);
    await reseal(f.bundle, (m) => {
      m.runHash = contentHash(JSON.parse(originalRun.toString()));
      const entries = m.files as {
        path: string;
        bytes: number;
        sha256: string;
      }[];
      const runEntry = entries.find((x) => x.path === "run.json");
      const sidecarEntry = entries.find(
        (x) => x.path === "logic-1/oracle-evidence.json",
      );
      if (!runEntry || !sidecarEntry) throw new Error("manifest entry missing");
      runEntry.bytes = originalRun.length;
      runEntry.sha256 = digest(originalRun);
      sidecarEntry.bytes = bytes.length;
      sidecarEntry.sha256 = digest(bytes);
    });
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("P6-10 stopped and Oracle-fail terminal records remain eligible for local bundling", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-bundle-negative-"));
  try {
    const limited = JSON.parse(await readFile(draft, "utf8"));
    limited.budget = 1;
    for (const task of limited.tasks) {
      for (const key of ["source", "metadata", "oracle", "fixture"] as const)
        if (task[key]) task[key] = resolve("research/paper-v1", task[key]);
    }
    const limitedPath = resolve(root, "limited.json");
    await writeFile(limitedPath, JSON.stringify(limited));
    const stoppedRun = resolve(root, "stopped-run");
    await runStudy(limitedPath, "fixture", stoppedRun);
    const stopped = await createStudyBundle(
      stoppedRun,
      resolve(root, "stopped-bundle"),
    );
    expect(stopped.report.counts.stopped).toBeGreaterThan(0);
    expect(stopped.recordIntegrity).toBe("verified");

    const altered = structuredClone(limited);
    altered.budget = null;
    altered.tasks = [altered.tasks[0]];
    const oraclePath = resolve(root, "wrong-oracle.json");
    const oracle = JSON.parse(await readFile(altered.tasks[0].oracle, "utf8"));
    oracle.cases[0].expected.value = !oracle.cases[0].expected.value;
    await writeFile(oraclePath, JSON.stringify(oracle));
    altered.tasks[0].oracle = oraclePath;
    const alteredPath = resolve(root, "altered.json");
    await writeFile(alteredPath, JSON.stringify(altered));
    const oracleRun = resolve(root, "oracle-run");
    await runStudy(alteredPath, "fixture", oracleRun);
    const failed = await createStudyBundle(
      oracleRun,
      resolve(root, "oracle-bundle"),
    );
    expect(failed.report.oracleFail).toBe(1);
    expect(failed.report.rows[0]?.oraclePass).toBe(false);
    expect(failed.evidenceEligible).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P6-10 generated failure is retained rather than excluded", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-bundle-fail-"));
  try {
    const study = JSON.parse(await readFile(draft, "utf8"));
    study.tasks = [study.tasks[0]];
    for (const key of ["source", "metadata", "oracle", "fixture"] as const)
      study.tasks[0][key] = resolve("research/paper-v1", study.tasks[0][key]);
    const fixtureValue = JSON.parse(
      await readFile(study.tasks[0].fixture, "utf8"),
    );
    fixtureValue.responses[2].reply.result.body = {
      kind: "equals",
      property: ["a"],
      value: true,
    };
    study.tasks[0].fixture = resolve(root, "responses.json");
    await writeFile(study.tasks[0].fixture, JSON.stringify(fixtureValue));
    const studyPath = resolve(root, "study.json");
    await writeFile(studyPath, JSON.stringify(study));
    const runDir = resolve(root, "run");
    const run = await runStudy(studyPath, "fixture", runDir);
    expect(run.trials[0]?.status).toBe("fail");
    const result = await createStudyBundle(runDir, resolve(root, "bundle"));
    expect(result.report.counts.fail).toBe(1);
    expect(result.report.completedTrials).toBe(1);
    expect(result.evidenceEligible).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P6-11/12/14 missing sidecar, lock contention and unsafe output fail", async () => {
  const f = await fixture();
  try {
    await withStudyRunLock(f.run, async () => {
      await expect(createStudyBundle(f.run, f.bundle)).rejects.toMatchObject({
        code: "PAPER_STUDY_LOCKED",
      });
      await expect(
        runPaperCli([
          "bundle-study",
          "--run-dir",
          f.run,
          "--out-dir",
          f.bundle,
        ]),
      ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCKED" });
    });
    await expect(lstat(f.bundle)).rejects.toThrow();
    await expect(
      createStudyBundle(f.run, resolve(f.run, "child")),
    ).rejects.toThrow("outside");
    await symlink(f.run, resolve(f.root, "alias"));
    await expect(
      createStudyBundle(f.run, resolve(f.root, "alias", "child")),
    ).rejects.toThrow("outside");
    await mkdir(f.bundle);
    await expect(createStudyBundle(f.run, f.bundle)).rejects.toThrow();
    await rm(f.bundle, { recursive: true });
    await unlink(resolve(f.run, "logic-1", "oracle-evidence.json"));
    await expect(createStudyBundle(f.run, f.bundle)).rejects.toThrow(
      "complete verified records",
    );
  } finally {
    await f.cleanup();
  }
});

test("P6-15/17 copy failure and observed source changes retain partial output", async () => {
  const f = await fixture();
  try {
    await expect(
      createStudyBundle(f.run, f.bundle, {
        afterCopyFile: async () => {
          throw new Error("copy failure");
        },
      }),
    ).rejects.toThrow("copy failure");
    expect((await lstat(f.bundle)).isDirectory()).toBe(true);
    await expect(lstat(resolve(f.run, ".paper-study.lock"))).rejects.toThrow();
    await rm(f.bundle, { recursive: true });
    await expect(
      createStudyBundle(f.run, f.bundle, {
        afterSourceScan: async () => {
          await writeFile(resolve(f.run, "extra.json"), "{}");
        },
      }),
    ).rejects.toThrow("file set");
    await expect(lstat(resolve(f.run, ".paper-study.lock"))).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("P6-13 cooperative resume cannot enter while a bundle holds the lock", async () => {
  const f = await fixture();
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  try {
    const bundle = createStudyBundle(f.run, f.bundle, {
      afterSourceScan: async () => {
        ready();
        await gate;
      },
    });
    await entered;
    await expect(resumeStudy(f.run)).rejects.toMatchObject({
      code: "PAPER_STUDY_LOCKED",
    });
    release();
    expect((await bundle).recordIntegrity).toBe("verified");
  } finally {
    release();
    await f.cleanup();
  }
});

test("P6-15/16 manifest failure retains partial output; release failure retains complete output", async () => {
  const f = await fixture();
  try {
    await expect(
      createStudyBundle(f.run, f.bundle, {
        beforeManifestPublish: async () => {
          throw new Error("manifest publish failed");
        },
      }),
    ).rejects.toThrow("manifest publish failed");
    await expect(lstat(resolve(f.bundle, "bundle.json"))).rejects.toThrow();
    await expect(lstat(resolve(f.run, ".paper-study.lock"))).rejects.toThrow();
    await rm(f.bundle, { recursive: true });
    const io: StudyLockIO = {
      realpath,
      stat,
      lstat,
      open,
      readFile,
      unlink: async (path) => {
        if (String(path).endsWith(".paper-study.lock"))
          throw new Error("release failed");
        await unlink(path);
      },
    };
    await expect(
      createStudyBundle(f.run, f.bundle, { lockIO: io }),
    ).rejects.toMatchObject({
      code: "PAPER_STUDY_LOCK_RELEASE_FAILED",
    });
    expect((await verifyStudyBundle(f.bundle)).recordIntegrity).toBe(
      "verified",
    );
    expect((await lstat(resolve(f.run, ".paper-study.lock"))).isFile()).toBe(
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("P6-18 saved live run verifies without original approval or model calls", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-bundle-live-"));
  try {
    const study = JSON.parse(await readFile(draft, "utf8"));
    const inputs = resolve(root, "inputs");
    await mkdir(inputs);
    for (const [index, task] of study.tasks.entries()) {
      for (const kind of ["source", "metadata", "oracle", "fixture"] as const) {
        if (!task[kind]) continue;
        const target = resolve(inputs, `${index}-${kind}.json`);
        await cp(resolve("research/paper-v1", task[kind]), target);
        task[kind] = target;
      }
      task.review = "reviewed";
      const oracle = JSON.parse(await readFile(task.oracle, "utf8"));
      oracle.review = "reviewed";
      await writeFile(task.oracle, JSON.stringify(oracle));
    }
    Object.assign(study, {
      state: "frozen",
      review: "reviewed",
      approval: "granted",
      unresolved: [],
      model: "gpt-5.6-terra",
      provider: "codex-sdk",
      maxOutputTokens: 1024,
      maxTotalTokens: 10000,
      maxWallMs: 60000,
      budget: 12,
    });
    const path = resolve(root, "study.json");
    await writeFile(path, JSON.stringify(study));
    study.frozenHashes = (await validateStudy(path)).hashes;
    await writeFile(path, JSON.stringify(study));
    const validation = await validateStudy(path);
    expect(validation.readyForLive).toBe(true);
    const approval = resolve(root, "approval.json");
    await writeFile(
      approval,
      JSON.stringify({
        studyHash: validation.studyHash,
        scope: "live",
        reviewer: "test",
        record: "test",
      }),
    );
    const fixtures = new Map<string, unknown>();
    for (const task of study.tasks)
      fixtures.set(task.id, JSON.parse(await readFile(task.fixture, "utf8")));
    const run = resolve(root, "run");
    await runStudy(path, "live", run, approval, {
      developmentObject: async (source, metadata, output) => {
        const { runDevelopmentObject } = await import(
          "./capability-development-cli"
        );
        return runDevelopmentObject(source, metadata, output, {
          mode: "fixture",
          fixture: fixtures.get((source as { id: string }).id),
        });
      },
    });
    const bundle = resolve(root, "bundle");
    await createStudyBundle(run, bundle);
    await rm(run, { recursive: true });
    await rm(inputs, { recursive: true });
    await unlink(path);
    await unlink(approval);
    const result = await verifyStudyBundle(bundle);
    expect(result.report.mode).toBe("live");
    expect(result.report.oraclePass).toBe(3);
    expect(result.evidenceEligible).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P6-17 verification second scan detects observed mutation", async () => {
  const f = await fixture();
  try {
    await createStudyBundle(f.run, f.bundle);
    await expect(
      verifyStudyBundle(f.bundle, {
        afterVerifyScan: async () => {
          await writeFile(resolve(f.bundle, "evidence", "new"), "x");
        },
      }),
    ).rejects.toThrow("file set");
  } finally {
    await f.cleanup();
  }
});

test("P6-17 verification rejects manifest changes after its first read", async () => {
  const f = await fixture();
  try {
    await createStudyBundle(f.run, f.bundle);
    await expect(
      verifyStudyBundle(f.bundle, {
        afterVerifyScan: async () => {
          const path = resolve(f.bundle, "bundle.json");
          await writeFile(path, `${await readFile(path, "utf8")} `);
        },
      }),
    ).rejects.toThrow("manifest changed");
  } finally {
    await f.cleanup();
  }
});

test("P6-11 missing candidate cannot be promoted by a valid sidecar", async () => {
  const f = await fixture();
  try {
    await rm(
      resolve(f.run, "logic-1", "attempt-1", "candidate", "capability.json"),
    );
    await expect(createStudyBundle(f.run, f.bundle)).rejects.toThrow(
      "complete verified records",
    );
    await expect(lstat(f.bundle)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("P6-15 manifest readback failure retains output and releases source", async () => {
  const f = await fixture();
  try {
    await expect(
      createStudyBundle(f.run, f.bundle, {
        afterManifestPublish: async () => {
          await writeFile(resolve(f.bundle, "evidence", "extra"), "x");
        },
      }),
    ).rejects.toThrow("file set");
    expect((await lstat(resolve(f.bundle, "bundle.json"))).isFile()).toBe(true);
    await expect(lstat(resolve(f.run, ".paper-study.lock"))).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("P6-06 special files are rejected even inside empty directories", async () => {
  const f = await fixture();
  const { createServer } = await import("node:net");
  const socket = resolve(f.run, "socket");
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    await expect(createStudyBundle(f.run, f.bundle)).rejects.toThrow(
      "symlink or special file",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

test("P6-19 forbidden entries and bundle-local report fail verification", async () => {
  const f = await fixture();
  try {
    await createStudyBundle(f.run, f.bundle);
    await writeFile(
      resolve(f.bundle, "evidence", ".paper-study.lock"),
      "stale",
    );
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow("forbidden");
    await unlink(resolve(f.bundle, "evidence", ".paper-study.lock"));
    await writeFile(resolve(f.bundle, "evidence", "reproduction.json"), "{}");
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow("forbidden");
    await unlink(resolve(f.bundle, "evidence", "reproduction.json"));
    await mkdir(resolve(f.bundle, "report"));
    await expect(verifyStudyBundle(f.bundle)).rejects.toThrow(
      "unexpected entries",
    );
  } finally {
    await f.cleanup();
  }
});

test("P6 CLI commands return verification JSON and validate options", async () => {
  const f = await fixture();
  try {
    const help = await runPaperCli(["--help"]);
    expect(JSON.stringify(help.result)).toContain("bundle-study");
    expect(JSON.stringify(help.result)).toContain("verify-study-bundle");
    await expect(
      runPaperCli(["bundle-study", "--run-dir", f.run]),
    ).rejects.toThrow("missing --out-dir");
    expect(
      (
        await runPaperCli([
          "bundle-study",
          "--run-dir",
          f.run,
          "--out-dir",
          f.bundle,
        ])
      ).exitCode,
    ).toBe(0);
    const result = await runPaperCli([
      "verify-study-bundle",
      "--bundle-dir",
      f.bundle,
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(result.result)).toContain(
      "llang-paper-study-bundle-verification",
    );
  } finally {
    await f.cleanup();
  }
});

test("P6 verifier does not compile or instantiate Wasm", async () => {
  const f = await fixture();
  const originalCompile = WebAssembly.compile;
  const originalInstantiate = WebAssembly.instantiate;
  try {
    await createStudyBundle(f.run, f.bundle);
    let calls = 0;
    WebAssembly.compile = ((
      ..._args: Parameters<typeof WebAssembly.compile>
    ) => {
      calls++;
      throw new Error("Wasm compile forbidden in verifier");
    }) as typeof WebAssembly.compile;
    WebAssembly.instantiate = ((
      ..._args: Parameters<typeof WebAssembly.instantiate>
    ) => {
      calls++;
      throw new Error("Wasm instantiate forbidden in verifier");
    }) as typeof WebAssembly.instantiate;
    expect((await verifyStudyBundle(f.bundle)).recordIntegrity).toBe(
      "verified",
    );
    expect(calls).toBe(0);
  } finally {
    WebAssembly.compile = originalCompile;
    WebAssembly.instantiate = originalInstantiate;
    await f.cleanup();
  }
});
