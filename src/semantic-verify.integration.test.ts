import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256 } from "./semantic-fingerprint";

describe("semantic verify CLI read-only integration", () => {
  test("renders text and JSON with stable exit codes without changing artifacts", async () => {
    const protectedPaths = [
      "semantic.lock",
      "examples/active-customer/is-active-customer.generated.ts",
      "examples/semantic-polymorphism/account/is-active-service-account.generated.ts",
      "examples/semantic-polymorphism/customer/is-active-customer-record.generated.ts",
      "examples/static-judgment/mike-is-cat.generated.ts",
    ];
    const before = await hashFiles(protectedPaths);
    const beforeTemporary = await temporarySemanticTests();

    const text = await runVerify(["semantic-closure.json"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("semantic verify");
    expect(text.stdout).toContain("status: passed");
    expect(text.stdout).toContain("api calls: 0");

    const json = await runVerify(["semantic-closure.json", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      version: 1,
      status: "passed",
      checks: {
        closure: { status: "passed" },
        deterministicGeneration: { passed: 4, failed: 0 },
        semanticTests: { passed: 3, failed: 0, skipped: 1 },
        typecheck: { status: "passed" },
      },
    });

    const open = await runVerify([
      "examples/semantic-closure/open.json",
      "--json",
    ]);
    expect(open.exitCode).toBe(2);
    expect(JSON.parse(open.stdout)).toMatchObject({
      status: "failed",
      checks: { closure: { status: "failed" } },
    });

    const fixture = await runVerify([
      "semantic-closure.json",
      "--fixture",
      "examples/active-customer/openai-response.fixture.json",
    ]);
    expect(fixture.exitCode).toBe(1);
    expect(fixture.stderr).toContain(
      "verify does not accept --fixture and never calls an API",
    );

    expect(await hashFiles(protectedPaths)).toEqual(before);
    expect(await temporarySemanticTests()).toEqual(beforeTemporary);
  }, 120_000);
});

async function runVerify(arguments_: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn(
    ["bun", "run", "src/semantic-cli.ts", "verify", ...arguments_],
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

async function hashFiles(paths: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, sha256(await readFile(resolve(path)))]),
    ),
  );
}

async function temporarySemanticTests(): Promise<string[]> {
  const directories = [
    "examples/active-customer",
    "examples/semantic-polymorphism/account",
    "examples/semantic-polymorphism/customer",
  ];
  const results = await Promise.all(
    directories.map(async (directory) =>
      (await readdir(resolve(directory)))
        .filter((name) => name.endsWith(".semantic.test.ts"))
        .map((name) => `${directory}/${name}`),
    ),
  );
  return results.flat().sort();
}
