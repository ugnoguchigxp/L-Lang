import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  cleanupSemanticFiles,
  createSemanticPipelineRun,
  semanticResponseMetadata,
  semanticRunDuration,
  writeSemanticJson,
} from "./semantic-pipeline";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("shared semantic compiler pipeline", () => {
  test("creates an audit run and shares JSON, metadata, and cleanup", async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), "semantic-pipeline-"),
    );
    temporaryRoots.push(workspaceRoot);
    const run = await createSemanticPipelineRun({
      workspaceRoot,
      defaultAuditKind: "candidates",
      commandRunner: async () => {},
    });
    expect(run.auditDirectory.replaceAll("\\", "/")).toContain(
      ".semantic/candidates/",
    );

    const jsonPath = resolve(run.auditDirectory, "input.json");
    await writeSemanticJson(jsonPath, { version: 1 });
    expect(JSON.parse(await readFile(jsonPath, "utf8"))).toEqual({
      version: 1,
    });
    expect(semanticResponseMetadata(null)).toBeNull();
    expect(
      semanticResponseMetadata({
        responseId: "response",
        model: "model",
        outputText: "{}",
        usage: null,
      }),
    ).toEqual({ id: "response", model: "model", usage: null });
    expect(semanticRunDuration(run)).toMatchObject({
      durationMs: expect.any(Number),
      completedAt: expect.any(String),
    });

    const candidate = resolve(workspaceRoot, "candidate.ts");
    await writeFile(candidate, "candidate\n", "utf8");
    await cleanupSemanticFiles([
      candidate,
      resolve(workspaceRoot, "missing.ts"),
    ]);
    await expect(access(candidate)).rejects.toThrow();
  });

  test("uses the default command runner and reports a failed stage", async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), "semantic-pipeline-"),
    );
    temporaryRoots.push(workspaceRoot);
    const run = await createSemanticPipelineRun({
      workspaceRoot,
      defaultAuditKind: "judgments",
    });

    await run.executeCommand(
      ["bun", "-e", "process.exit(0)"],
      workspaceRoot,
      "success",
    );
    await expect(
      run.executeCommand(
        ["bun", "-e", "process.exit(7)"],
        workspaceRoot,
        "failure-stage",
      ),
    ).rejects.toThrow("failure-stage failed with exit code 7");
  });
});
