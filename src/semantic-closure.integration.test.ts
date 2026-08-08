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
      "benchmarks/schema-evolution/benchmark.json",
      "benchmarks/schema-evolution/freeze.json",
    ];
    const beforeFiles = await hashFiles(workspaceRoot, protectedPaths);
    const beforeAudit = await hashTree(
      resolve(workspaceRoot, ".semantic"),
      ["test-workspaces", "candidates", "judgments", "test-plan-reviews"],
    );

    const text = await runClosure(["semantic-closure.json"]);
    expect([0, 2]).toContain(text.exitCode);
    expect(text.stdout).toContain("status:");
    expect(text.stdout).toContain("project fit:");

    const json = await runClosure(["semantic-closure.json", "--json"]);
    expect([0, 2]).toContain(json.exitCode);
    const parsedRoot = JSON.parse(json.stdout) as {
      version: number;
      scope: string;
      status: "closed" | "open";
      summary: { total: number };
      projectFit: { verified: number; required: number };
    };
    expect(parsedRoot).toMatchObject({
      version: 1,
      scope: "artifact",
      summary: { total: 4 },
    });
    expect(
      parsedRoot.projectFit.verified + parsedRoot.projectFit.required,
    ).toBe(parsedRoot.summary.total);
    expect(json.exitCode).toBe(parsedRoot.status === "closed" ? 0 : 2);
    expect(text.stdout).toContain(`status: ${parsedRoot.status}`);

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
    expect(
      await hashTree(resolve(workspaceRoot, ".semantic"), [
        "test-workspaces",
        "candidates",
        "judgments",
        "test-plan-reviews",
      ]),
    ).toEqual(beforeAudit);
  }, 60_000);
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

async function hashTree(
  root: string,
  ignoredTopLevel: string[] = [],
): Promise<Record<string, string>> {
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
    .filter((path) => {
      const relativePath = relative(root, path).replaceAll("\\", "/");
      return !ignoredTopLevel.some(
        (ignored) =>
          relativePath === ignored || relativePath.startsWith(`${ignored}/`),
      );
    })
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
