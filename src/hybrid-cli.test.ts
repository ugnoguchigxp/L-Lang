import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { runHybridCli } from "./hybrid-cli";

const repo = resolve(import.meta.dir, "..");
const cli = resolve(repo, "src/hybrid-cli.ts");
const example = resolve(repo, "examples/hybrid-order/can-ship.ts");
const childEnv = {
  ...process.env,
  OPENAI_API_KEY: "",
  AZURE_OPENAI_API_KEY: "",
};

async function child(args: string[]) {
  const childProcess = Bun.spawn([process.execPath, cli, ...args], {
    cwd: repo,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
    childProcess.exited,
  ]);
  return { stdout, stderr, code };
}

describe("hybrid inspect-ts CLI", () => {
  test("prints one read-only JSON result without credentials", async () => {
    const before = await readFile(example, "utf8");
    const result = await child([
      "inspect-ts",
      "examples/hybrid-order/can-ship.ts",
      "--function",
      "canShip",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      version: 1,
      profile: "predicate-i32-v1",
      source: {
        file: "examples/hybrid-order/can-ship.ts",
        functionName: "canShip",
      },
      input: {
        canonicalType: { version: 1, kind: "record" },
        canonicalTypeHash:
          "b13eaa780859bc44c6836956488a8cb898f92ef75973a418fb41337f242da7c1",
        mapping: {
          provider: "typescript",
          status: "lossless",
          diagnostics: [],
        },
      },
      projections: {
        jsonSchema: {
          status: "requires-host-adapter",
          diagnostics: [
            { code: "EXPLICIT_UNDEFINED_NOT_JSON", path: ["cancelled"] },
            { code: "EXPLICIT_UNDEFINED_NOT_JSON", path: ["holdReason"] },
          ],
        },
        specification: {
          format: "markdown",
          status: "implementation-description",
        },
      },
      apiCalls: 0,
      writes: 0,
    });
    expect(await readFile(example, "utf8")).toBe(before);
  });

  test("rejects invalid arguments on stderr", async () => {
    const result = await child(["inspect-ts", example]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: hybrid inspect-ts");
  });

  test("exports an import-safe API", async () => {
    const result = await runHybridCli(
      [
        "inspect-ts",
        "examples/hybrid-order/can-ship.ts",
        "--function",
        "needsManualReview",
      ],
      repo,
    );
    expect(result).toHaveProperty("apiCalls", 0);
    expect(result).toHaveProperty("writes", 0);
  });

  test("builds and verifies a reproducible artifact", async () => {
    const directory = await mkdtemp(resolve(repo, ".tmp-hybrid-cli-"));
    try {
      const output = resolve(directory, "can-ship");
      const built = await child([
        "build-ts",
        "examples/hybrid-order/can-ship.ts",
        "--function",
        "canShip",
        "--out",
        output,
      ]);
      expect(built.code).toBe(0);
      expect(built.stderr).toBe("");
      const buildOutput = JSON.parse(built.stdout);
      expect(buildOutput).toMatchObject({
        artifactHash:
          "467d27707f526f16052a5cafa3bd4406c901fd3b7cdd2375b7ae6e66ea3d5972",
        semanticHash:
          "e92e379d4b51cab9e551b945f74fe381f2e539396ef03dc8aeebcac0403d8e69",
        apiCalls: 0,
      });
      const portable = await child([
        "verify-artifact",
        resolve(output, "artifact.json"),
      ]);
      expect(portable.code).toBe(0);
      expect(portable.stderr).toBe("");
      expect(JSON.parse(portable.stdout)).toMatchObject({
        mode: "portable",
        status: "passed",
        writes: 0,
      });
      const rebuilt = await child([
        "verify-artifact",
        resolve(output, "artifact.json"),
        "--rebuild",
      ]);
      expect(rebuilt.code).toBe(0);
      expect(rebuilt.stderr).toBe("");
      expect(JSON.parse(rebuilt.stdout)).toMatchObject({
        mode: "rebuild",
        status: "passed",
        temporaryWrites: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("strictly rejects malformed artifact command arguments", async () => {
    for (const args of [
      ["build-ts", example, "--function", "canShip"],
      ["build-ts", example, "--function", "canShip", "--out", "x", "extra"],
      ["verify-artifact"],
      ["verify-artifact", example, "--unknown"],
      ["unknown"],
    ]) {
      const result = await child(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("INVALID_ARGUMENT: usage:");
    }
  });

  test("does not expose absolute paths for artifact read failures", async () => {
    const missing = resolve(repo, "missing-private-artifact/artifact.json");
    const result = await child(["verify-artifact", missing]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "HYBRID_OPERATION_FAILED: operation could not be completed\n",
    );
    expect(result.stderr).not.toContain(repo);
  });
});
