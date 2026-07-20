import { describe, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

import { sha256 } from "./semantic-fingerprint";

describe("semantic explain CLI read-only integration", () => {
  test("treats an absent audit directory as an empty read-only baseline", async () => {
    expect(
      await hashTree(
        resolve(tmpdir(), `semantic-explain-absent-${crypto.randomUUID()}`),
      ),
    ).toEqual({});
  });

  test("explains Predicate and Static Judgment as text and JSON without changing workspace artifacts", async () => {
    const workspaceRoot = process.cwd();
    const protectedPaths = [
      "semantic.lock",
      "examples/active-customer/is-active-customer.generated.ts",
      "examples/static-judgment/mike-is-cat.generated.ts",
      "benchmarks/schema-evolution-v2/benchmark.json",
    ];
    const beforeFiles = await hashFiles(workspaceRoot, protectedPaths);
    const beforeAudit = await hashTree(resolve(workspaceRoot, ".semantic"));

    const predicateText = await runExplain([
      "examples/active-customer/semantic.ts",
    ]);
    expect(predicateText.exitCode).toBe(0);
    expect(predicateText.stdout).toContain("status: current");
    expect(predicateText.stdout).toContain("generated integrity: verified");

    const predicateJson = await runExplain([
      "examples/active-customer/semantic.ts",
      "--json",
    ]);
    expect(predicateJson.exitCode).toBe(0);
    expect(JSON.parse(predicateJson.stdout)).toMatchObject({
      version: 1,
      kind: "predicate",
      status: "current",
      generated: { state: "verified" },
    });

    const judgmentText = await runExplain([
      "examples/static-judgment/semantic.ts",
    ]);
    expect(judgmentText.exitCode).toBe(0);
    expect(judgmentText.stdout).toContain("kind: static-judgment");
    expect(judgmentText.stdout).toContain("result: true");

    const judgmentJson = await runExplain([
      "examples/static-judgment/semantic.ts",
      "--json",
    ]);
    expect(judgmentJson.exitCode).toBe(0);
    const parsedJudgment = JSON.parse(judgmentJson.stdout) as Record<string, unknown>;
    expect(parsedJudgment).toMatchObject({
      version: 1,
      kind: "static-judgment",
      status: "current",
      resolution: { value: true },
    });
    expect(judgmentJson.stdout).not.toContain(
      "A small domesticated calico animal that meows.",
    );

    const rejectedFixture = await runExplain([
      "examples/active-customer/semantic.ts",
      "--fixture",
      "examples/active-customer/openai-response.fixture.json",
    ]);
    expect(rejectedFixture.exitCode).not.toBe(0);
    expect(rejectedFixture.stderr).toContain(
      "explain does not accept --fixture and never calls an API",
    );

    const rejectedUnknownOption = await runExplain([
      "examples/active-customer/semantic.ts",
      "--unknown",
    ]);
    expect(rejectedUnknownOption.exitCode).not.toBe(0);
    expect(rejectedUnknownOption.stderr).toContain(
      "explain does not accept --unknown",
    );

    expect(await hashFiles(workspaceRoot, protectedPaths)).toEqual(beforeFiles);
    expect(await hashTree(resolve(workspaceRoot, ".semantic"))).toEqual(beforeAudit);
  }, 30_000);
});

async function runExplain(arguments_: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn(
    ["bun", "run", "src/semantic-cli.ts", "explain", ...arguments_],
    {
      cwd: process.cwd(),
      env: { ...process.env, OPENAI_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function hashFiles(
  root: string,
  paths: string[],
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        sha256(await readFile(resolve(root, path))),
      ]),
    ),
  );
}

async function hashTree(root: string): Promise<Record<string, string>> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
  const paths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        relative(root, path).replaceAll("\\", "/"),
        sha256(await readFile(path)),
      ]),
    ),
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
