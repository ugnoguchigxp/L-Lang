import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runPaperCli } from "./paper-cli";
import { runStudy } from "./paper-study";
import { withStudyRunLock } from "./paper-study-lock";

test("paper CLI lists commands and rejects missing required options", async () => {
  const help = await runPaperCli(["--help"]);
  expect(help.exitCode).toBe(0);
  expect(JSON.stringify(help.result)).toContain("report");
  expect(JSON.stringify(help.result)).toContain("review-study");
  expect(JSON.stringify(help.result)).toContain("verify-study-review");
  await expect(
    runPaperCli(["inventory", "--input", "missing"]),
  ).rejects.toThrow("missing --out-dir");
});
test("review-study CLI writes draft review and refuses an existing directory", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-review-cli-"));
  try {
    const args = [
      "review-study",
      "--study",
      "research/paper-v1/study-draft.json",
      "--out-dir",
      resolve(root, "review"),
    ];
    expect((await runPaperCli(args)).exitCode).toBe(0);
    expect(await Bun.file(resolve(root, "review/review.json")).exists()).toBe(
      true,
    );
    await expect(runPaperCli(args)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("review-study CLI returns one and retains diagnostic output", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-review-diagnostic-"));
  try {
    const study = JSON.parse(
      await readFile(resolve("research/paper-v1/study-draft.json"), "utf8"),
    );
    study.tasks = [study.tasks[0]];
    for (const key of ["source", "metadata", "oracle", "fixture"])
      study.tasks[0][key] = resolve("research/paper-v1", study.tasks[0][key]);
    study.tasks[0].id = "changed";
    const path = resolve(root, "study.json");
    await writeFile(path, JSON.stringify(study));
    const result = await runPaperCli([
      "review-study",
      "--study",
      path,
      "--out-dir",
      resolve(root, "review"),
    ]);
    expect(result.exitCode).toBe(1);
    expect(await Bun.file(resolve(root, "review/review.json")).exists()).toBe(
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5-20 CLI lock contention rejects and entry point exits two", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-cli-lock-"));
  try {
    const dir = resolve(root, "run");
    await runStudy(
      resolve("research/paper-v1/study-draft.json"),
      "fixture",
      dir,
    );
    await withStudyRunLock(dir, async () => {
      await expect(
        runPaperCli(["resume-study", "--run-dir", dir]),
      ).rejects.toMatchObject({ code: "PAPER_STUDY_LOCKED" });
      const child = Bun.spawnSync([
        process.execPath,
        resolve("src/paper-cli.ts"),
        "resume-study",
        "--run-dir",
        dir,
      ]);
      expect(child.exitCode).toBe(2);
      expect(new TextDecoder().decode(child.stderr)).toContain(
        "PAPER_STUDY_LOCKED",
      );
    });
    expect(
      (await runPaperCli(["resume-study", "--run-dir", dir])).exitCode,
    ).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
