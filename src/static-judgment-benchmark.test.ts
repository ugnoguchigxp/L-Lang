import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { sha256 } from "./semantic-fingerprint";
import { parseStaticJudgmentBenchmarkCliArguments } from "./static-judgment-benchmark-cli";
import {
  buildStaticJudgmentBenchmarkRequests,
  loadStaticJudgmentBenchmark,
  parseStaticJudgmentBenchmarkFixture,
  parseStaticJudgmentBenchmarkFreeze,
  parseStaticJudgmentBenchmarkManifest,
  parseStaticJudgmentBenchmarkOracle,
  renderStaticJudgmentBenchmarkReport,
  runStaticJudgmentFixtureBenchmark,
  verifyStaticJudgmentBenchmarkFreeze,
} from "./static-judgment-benchmark";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("Static Judgment blind benchmark", () => {
  test("strictly parses its read-only CLI contract", () => {
    expect(
      parseStaticJudgmentBenchmarkCliArguments([
        "fixture",
        "benchmark.json",
        "--json",
      ]),
    ).toEqual({
      command: "fixture",
      manifestPath: "benchmark.json",
      json: true,
    });
    expect(() =>
      parseStaticJudgmentBenchmarkCliArguments(["live", "benchmark.json"]),
    ).toThrow("usage:");
    expect(() =>
      parseStaticJudgmentBenchmarkCliArguments([
        "fixture",
        "benchmark.json",
        "--output",
        "report.json",
      ]),
    ).toThrow("does not accept");
  });

  test("runs a frozen read-only fixture without exposing its Oracle", async () => {
    const fixture = await createBenchmark();
    const protocol = await loadStaticJudgmentBenchmark(fixture.manifestPath);
    const before = await hashProtocolFiles(fixture);

    const requests = await buildStaticJudgmentBenchmarkRequests(protocol);
    expect(requests).toHaveLength(2);
    const visible = JSON.stringify(requests);
    expect(visible).not.toContain("HIDDEN_ORACLE_MARKER");
    expect(visible).not.toContain('"expected"');

    const report = await runStaticJudgmentFixtureBenchmark(protocol);
    expect(report).toMatchObject({
      version: 1,
      benchmark: "static-judgment-fixture",
      profile: "fixture",
      evidenceEligible: false,
      status: "passed",
      cases: 2,
      repetitions: 3,
      runs: 6,
      metrics: {
        passed: 6,
        falseResolutions: 0,
        unexpectedUnresolved: 0,
        resolvedAccuracy: 1,
        stabilityRate: 1,
      },
      apiCalls: 0,
      persistentFilesWritten: 0,
    });
    expect(renderStaticJudgmentBenchmarkReport(report)).toContain(
      "false resolutions: 0",
    );
    const cli = await runFixtureCli(fixture.manifestPath);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      version: 1,
      status: "passed",
      apiCalls: 0,
      persistentFilesWritten: 0,
    });
    expect(cli.stderr).toBe("");
    expect(await hashProtocolFiles(fixture)).toEqual(before);
  });

  test("fails closed for draft, changed, and symbolic-link inputs", async () => {
    const draft = await createBenchmark({ frozen: false });
    await expect(
      verifyStaticJudgmentBenchmarkFreeze(
        await loadStaticJudgmentBenchmark(draft.manifestPath),
      ),
    ).rejects.toThrow("must be frozen before execution");

    const changed = await createBenchmark();
    await writeFile(
      resolve(changed.directory, "inputs/cat.json"),
      `${JSON.stringify(modelInput("A metal sculpture."), null, 2)}\n`,
      "utf8",
    );
    await expect(
      verifyStaticJudgmentBenchmarkFreeze(
        await loadStaticJudgmentBenchmark(changed.manifestPath),
      ),
    ).rejects.toThrow("frozen input changed");
    await expect(
      runStaticJudgmentFixtureBenchmark(
        await loadStaticJudgmentBenchmark(changed.manifestPath),
      ),
    ).rejects.toThrow("frozen input changed");

    const linked = await createBenchmark();
    const target = resolve(linked.directory, "inputs/cat-target.json");
    const link = resolve(linked.directory, "inputs/cat.json");
    await writeFile(target, await readFile(link));
    await rm(link);
    await symlink(target, link);
    await expect(
      verifyStaticJudgmentBenchmarkFreeze(
        await loadStaticJudgmentBenchmark(linked.manifestPath),
      ),
    ).rejects.toThrow("must not use a symbolic link");

    const linkedFreeze = await createBenchmark();
    const freezeTarget = resolve(linkedFreeze.directory, "freeze-target.json");
    await writeFile(freezeTarget, await readFile(linkedFreeze.freezePath));
    await rm(linkedFreeze.freezePath);
    await symlink(freezeTarget, linkedFreeze.freezePath);
    await expect(
      loadStaticJudgmentBenchmark(linkedFreeze.manifestPath),
    ).rejects.toThrow("freeze must not use a symbolic link");

    const linkedManifest = await createBenchmark();
    const manifestLink = resolve(linkedManifest.directory, "manifest-link.json");
    await symlink(linkedManifest.manifestPath, manifestLink);
    await expect(loadStaticJudgmentBenchmark(manifestLink)).rejects.toThrow(
      "manifest must not use a symbolic link",
    );
  });

  test("classifies false resolutions and instability against frozen thresholds", async () => {
    const fixture = await createBenchmark();
    await writeJson(resolve(fixture.directory, "fixtures/ambiguous.json"), {
      version: 1,
      results: [
        { outcome: "resolved", value: true, diagnostics: [] },
        { outcome: "unresolved", value: null, diagnostics: [] },
        { outcome: "resolved", value: false, diagnostics: [] },
      ],
    });
    await freezeBenchmark(fixture);

    const report = await runStaticJudgmentFixtureBenchmark(
      await loadStaticJudgmentBenchmark(fixture.manifestPath),
    );
    expect(report.status).toBe("failed");
    expect(report.metrics).toMatchObject({
      falseResolutions: 2,
      unexpectedUnresolved: 0,
      stabilityRate: 0.5,
    });
    expect(
      report.results.filter(
        (result) => result.classification === "false-resolution",
      ),
    ).toHaveLength(2);
    const cli = await runFixtureCli(fixture.manifestPath);
    expect(cli.exitCode).toBe(2);
    expect(JSON.parse(cli.stdout).status).toBe("failed");
  });

  test("strictly rejects malformed manifests, Oracles, and fixtures", () => {
    expect(() =>
      parseStaticJudgmentBenchmarkManifest({
        ...manifest(),
        extra: true,
      }),
    ).toThrow("must contain exactly");
    expect(() =>
      parseStaticJudgmentBenchmarkManifest({
        ...manifest(),
        cases: [
          {
            id: "escape",
            modelInput: "../input.json",
            oracle: "oracles/a.json",
            fixture: "fixtures/a.json",
          },
        ],
      }),
    ).toThrow("must be a safe relative path");
    expect(() =>
      parseStaticJudgmentBenchmarkManifest({
        ...manifest(),
        freeze: "./freeze.json",
      }),
    ).toThrow("must be a safe relative path");
    expect(() =>
      parseStaticJudgmentBenchmarkManifest({
        ...manifest(),
        profile: "held-out",
      }),
    ).toThrow("exactly 48 held-out cases");
    expect(() =>
      parseStaticJudgmentBenchmarkManifest({
        ...manifest(),
        thresholds: {
          ...(
            manifest() as {
              thresholds: Record<string, number>;
            }
          ).thresholds,
          maxFalseResolutions: 1,
        },
      }),
    ).toThrow("maxFalseResolutions must be 0");
    expect(() =>
      parseStaticJudgmentBenchmarkOracle({
        version: 1,
        expected: { outcome: "resolved", value: null },
        reason: "invalid",
      }),
    ).toThrow("resolved with a boolean");
    expect(() =>
      parseStaticJudgmentBenchmarkFixture(
        {
          version: 1,
          results: [{ outcome: "resolved", value: true, diagnostics: [] }],
        },
        3,
      ),
    ).toThrow("exactly 3 items");
    expect(() =>
      parseStaticJudgmentBenchmarkFreeze({
        version: 1,
        status: "frozen",
        frozenAt: "July 25, 2026",
        files: {},
      }),
    ).toThrow("ISO-8601");
  });
});

type BenchmarkFixture = {
  directory: string;
  manifestPath: string;
  freezePath: string;
  protectedPaths: string[];
};

async function createBenchmark(
  options: { frozen?: boolean } = {},
): Promise<BenchmarkFixture> {
  const directory = await mkdtemp(
    resolve(tmpdir(), "static-judgment-benchmark-"),
  );
  temporaryRoots.push(directory);
  const manifestPath = resolve(directory, "benchmark.json");
  const freezePath = resolve(directory, "freeze.json");
  const protectedPaths = [
    "benchmark.json",
    "inputs/cat.json",
    "inputs/ambiguous.json",
    "oracles/cat.json",
    "oracles/ambiguous.json",
    "fixtures/cat.json",
    "fixtures/ambiguous.json",
  ];
  await Promise.all([
    writeJson(resolve(directory, "inputs/cat.json"), modelInput("A calico cat.")),
    writeJson(
      resolve(directory, "inputs/ambiguous.json"),
      modelInput("Mike is mentioned without any description."),
    ),
    writeJson(resolve(directory, "oracles/cat.json"), {
      version: 1,
      expected: { outcome: "resolved", value: true },
      reason: "HIDDEN_ORACLE_MARKER: the value explicitly describes a cat",
    }),
    writeJson(resolve(directory, "oracles/ambiguous.json"), {
      version: 1,
      expected: { outcome: "unresolved", value: null },
      reason: "HIDDEN_ORACLE_MARKER: the value lacks species evidence",
    }),
    writeJson(resolve(directory, "fixtures/cat.json"), {
      version: 1,
      results: Array.from({ length: 3 }, () => ({
        outcome: "resolved",
        value: true,
        diagnostics: [],
      })),
    }),
    writeJson(resolve(directory, "fixtures/ambiguous.json"), {
      version: 1,
      results: Array.from({ length: 3 }, () => ({
        outcome: "unresolved",
        value: null,
        diagnostics: ["species evidence is missing"],
      })),
    }),
  ]);
  await writeJson(manifestPath, manifest());
  const fixture = { directory, manifestPath, freezePath, protectedPaths };
  if (options.frozen === false) {
    await writeJson(freezePath, {
      version: 1,
      status: "draft",
      frozenAt: null,
      files: {},
    });
  } else {
    await freezeBenchmark(fixture);
  }
  return fixture;
}

function manifest(): object {
  return {
    version: 1,
    profile: "fixture",
    name: "static-judgment-fixture",
    repetitions: 3,
    freeze: "freeze.json",
    thresholds: {
      maxFalseResolutions: 0,
      maxUnexpectedUnresolved: 0,
      minResolvedAccuracy: 1,
      minStabilityRate: 1,
    },
    cases: [
      {
        id: "cat-positive",
        modelInput: "inputs/cat.json",
        oracle: "oracles/cat.json",
        fixture: "fixtures/cat.json",
      },
      {
        id: "cat-ambiguous",
        modelInput: "inputs/ambiguous.json",
        oracle: "oracles/ambiguous.json",
        fixture: "fixtures/ambiguous.json",
      },
    ],
  };
}

function modelInput(staticValue: string): object {
  return {
    version: 1,
    model: "fixture-model",
    conceptId: "animal.cat",
    conceptSpecification: "Definition:\nA domesticated biological cat.",
    staticValue,
    judgmentName: "isCat",
  };
}

async function freezeBenchmark(fixture: BenchmarkFixture): Promise<void> {
  const files = Object.fromEntries(
    await Promise.all(
      fixture.protectedPaths.map(async (path) => [
        path,
        sha256(await readFile(resolve(fixture.directory, path))),
      ]),
    ),
  );
  await writeJson(fixture.freezePath, {
    version: 1,
    status: "frozen",
    frozenAt: "2026-07-25T00:00:00.000Z",
    files,
  });
}

async function hashProtocolFiles(
  fixture: BenchmarkFixture,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      [...fixture.protectedPaths, "freeze.json"].map(async (path) => [
        path,
        sha256(await readFile(resolve(fixture.directory, path))),
      ]),
    ),
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runFixtureCli(manifestPath: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "src/static-judgment-benchmark-cli.ts",
      "fixture",
      manifestPath,
      "--json",
    ],
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
