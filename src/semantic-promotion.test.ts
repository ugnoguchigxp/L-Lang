import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { promoteSemanticArtifact } from "./semantic-promotion";
import { serializeSemanticLock, type SemanticLock } from "./semantic-lock";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("semantic promotion transaction", () => {
  test("commits the generated output and lock after the full test passes", async () => {
    const fixture = await createFixture();
    const stages: string[] = [];

    await promoteSemanticArtifact({
      ...fixture,
      generatedCode: "new output\n",
      runFullTest: async () => {
        stages.push("full-test");
        expect(await readFile(fixture.outputPath, "utf8")).toBe("new output\n");
        expect(await readFile(fixture.lockPath, "utf8")).toBe("old lock\n");
      },
      writeLock: async (path, lock) => {
        stages.push("lock");
        await writeFile(path, serializeSemanticLock(lock), "utf8");
      },
    });

    expect(stages).toEqual(["full-test", "lock"]);
    expect(await readFile(fixture.outputPath, "utf8")).toBe("new output\n");
    expect(JSON.parse(await readFile(fixture.lockPath, "utf8"))).toEqual(
      fixture.nextLock,
    );
  });

  test("restores an existing output when the full test fails", async () => {
    const fixture = await createFixture();

    await expect(
      promoteSemanticArtifact({
        ...fixture,
        generatedCode: "new output\n",
        runFullTest: async () => {
          throw new Error("full test failed");
        },
      }),
    ).rejects.toThrow("full test failed");

    expect(await readFile(fixture.outputPath, "utf8")).toBe("old output\n");
    expect(await readFile(fixture.lockPath, "utf8")).toBe("old lock\n");
  });

  test("removes a newly created output when the lock write fails", async () => {
    const fixture = await createFixture({ output: null });

    await expect(
      promoteSemanticArtifact({
        ...fixture,
        generatedCode: "new output\n",
        runFullTest: async () => {},
        writeLock: async () => {
          throw new Error("lock write failed");
        },
      }),
    ).rejects.toThrow("lock write failed");

    await expect(readFile(fixture.outputPath, "utf8")).rejects.toThrow();
    expect(await readFile(fixture.lockPath, "utf8")).toBe("old lock\n");
  });

  test("restores both artifacts when the lock writer commits and then fails", async () => {
    const fixture = await createFixture();

    await expect(
      promoteSemanticArtifact({
        ...fixture,
        generatedCode: "new output\n",
        runFullTest: async () => {},
        writeLock: async (path, lock) => {
          await writeFile(path, serializeSemanticLock(lock), "utf8");
          throw new Error("post-commit lock failure");
        },
      }),
    ).rejects.toThrow("post-commit lock failure");

    expect(await readFile(fixture.outputPath, "utf8")).toBe("old output\n");
    expect(await readFile(fixture.lockPath, "utf8")).toBe("old lock\n");
  });
});

async function createFixture(options: { output?: string | null } = {}) {
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), "semantic-promotion-"));
  temporaryRoots.push(workspaceRoot);
  const outputPath = resolve(workspaceRoot, "generated.ts");
  const lockPath = resolve(workspaceRoot, "semantic.lock");
  if (options.output !== null) {
    await writeFile(outputPath, options.output ?? "old output\n", "utf8");
  }
  await writeFile(lockPath, "old lock\n", "utf8");
  const nextLock: SemanticLock = { version: 1, entries: {} };
  return { outputPath, lockPath, nextLock, workspaceRoot };
}
