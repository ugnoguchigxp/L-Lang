import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  atomicWriteText,
  type ProjectFitLiveCheckpoint,
  projectFitFileExists,
  validateProjectFitCompletedResponseBudget,
} from "./project-fit-live-checkpoint";
import { SEMANTIC_LIMITS } from "./semantic-limits";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Project Fit live checkpoint persistence", () => {
  test("checks report existence without reading it as a bounded checkpoint", async () => {
    const root = await temporaryRoot();
    const report = resolve(root, "report.json");
    await writeFile(
      report,
      Buffer.alloc(SEMANTIC_LIMITS.externalJsonBytes + 1),
    );

    expect(await projectFitFileExists(report)).toBe(true);
    expect(await projectFitFileExists(resolve(root, "missing.json"))).toBe(
      false,
    );
  });

  test("removes its temporary file when the final rename fails", async () => {
    const root = await temporaryRoot();
    const target = resolve(root, "target");
    await mkdir(target);

    await expect(atomicWriteText(target, "value")).rejects.toThrow();
    expect(
      (await readdir(root)).filter((name) => name.includes(".atomic.tmp")),
    ).toEqual([]);
  });

  test("fails closed when a completed response has no usage", () => {
    const checkpoint: ProjectFitLiveCheckpoint = {
      version: 2,
      manifestHash: "a".repeat(64),
      model: "fixture-model",
      provider: "fixture",
      costPerMillionTokens: { input: 1, output: 1 },
      entries: [
        {
          key: "initial:case:typeOnly:1",
          stage: "initial",
          caseId: "case",
          arm: "typeOnly",
          trial: 1,
          status: "completed",
          response: {
            responseId: "response",
            model: "fixture-model",
            outputText: "{}",
            usage: null,
          },
          latencyMs: 1,
        },
      ],
    };

    expect(() =>
      validateProjectFitCompletedResponseBudget(checkpoint, 1_000, 1_000),
    ).toThrow("response usage is required");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "project-fit-checkpoint-"));
  roots.push(root);
  return root;
}
