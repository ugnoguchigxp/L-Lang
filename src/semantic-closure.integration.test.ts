import { describe, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { sha256 } from "./semantic-fingerprint";

describe("semantic closure CLI read-only integration", () => {
  test("reports closed and open graphs with fail-closed exit codes without changing artifacts", async () => {
    const workspaceRoot = process.cwd();
    const protectedPaths = [
      "semantic.lock",
      "examples/active-customer/is-active-customer.generated.ts",
      "examples/semantic-polymorphism/account/is-active-service-account.generated.ts",
      "examples/semantic-polymorphism/customer/is-active-customer-record.generated.ts",
      "examples/static-judgment/mike-is-cat.generated.ts",
      "benchmarks/schema-evolution-v2/benchmark.json",
      "benchmarks/schema-evolution-v2/freeze.json",
    ];
    const beforeFiles = await hashFiles(workspaceRoot, protectedPaths);
    const beforeAudit = await hashTree(resolve(workspaceRoot, ".semantic"));

    const text = await runClosure(["semantic-closure.json"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("status: closed");
    expect(text.stdout).toContain("summary: 4/4 current");
    expect(text.stdout).toContain("approval: unknown");

    const json = await runClosure(["semantic-closure.json", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      version: 1,
      scope: "artifact",
      status: "closed",
      approval: "unknown",
      summary: { total: 4, current: 4 },
    });

    const open = await runClosure(["examples/semantic-closure/open.json", "--json"]);
    expect(open.exitCode).toBe(2);
    expect(JSON.parse(open.stdout)).toMatchObject({
      status: "open",
      summary: { total: 1, unlocked: 1 },
      blockers: [{ nodeId: "ambiguous-account", code: "unlocked" }],
    });

    const fixture = await runClosure([
      "semantic-closure.json",
      "--fixture",
      "examples/active-customer/openai-response.fixture.json",
    ]);
    expect(fixture.exitCode).toBe(1);
    expect(fixture.stderr).toContain(
      "closure does not accept --fixture and never calls an API",
    );

    const unknown = await runClosure(["semantic-closure.json", "--unknown"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("closure does not accept --unknown");

    expect(await hashFiles(workspaceRoot, protectedPaths)).toEqual(beforeFiles);
    expect(await hashTree(resolve(workspaceRoot, ".semantic"))).toEqual(beforeAudit);
  }, 30_000);
});

async function runClosure(arguments_: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn(
    ["bun", "run", "src/semantic-cli.ts", "closure", ...arguments_],
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
