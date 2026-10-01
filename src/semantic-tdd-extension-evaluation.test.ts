import { beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluateTddExtensions,
  type ExtensionEvaluation,
} from "./semantic-tdd-extension-evaluation";
import { stableJson } from "./semantic-fingerprint";
const benchmarkPath = resolve(
  import.meta.dir,
  "../benchmarks/semantic-tdd-extensions-v1/benchmark.json",
);
let result: ExtensionEvaluation;
beforeAll(async () => {
  result = await evaluateTddExtensions({ benchmarkPath });
}, 30000);

test("frozen synthetic controls compare the paired baseline without leaking held-out labels", () => {
  expect(result.status).toBe("completed");
  expect(result.rows).toHaveLength(12);
  expect(result.apiCalls).toBe(0);
  expect(result.rows.filter((r) => r.single.unresolved)).toHaveLength(9);
  expect(result.rows.filter((r) => r.bestOfN.unresolved)).toHaveLength(3);
  for (const row of result.rows) {
    expect(stableJson(row.selection.request)).not.toContain("novel-held-out");
    expect(row.bestOfN.falseAcceptance + row.bestOfN.falseRejection).toBe(0);
    expect(row.propertyDefect?.status).toBe("failed");
    expect(row.counterexampleReproduced).toBe(true);
    if (!row.bestOfN.unresolved) expect(row.property?.status).toBe("passed");
  }
});
test("replays saved evidence without API calls and rejects altered selection/freeze", async () => {
  expect(
    await evaluateTddExtensions({ benchmarkPath, previous: result }),
  ).toEqual(result);
  await expect(
    evaluateTddExtensions({
      benchmarkPath,
      previous: { ...result, freezeHash: "0".repeat(64) },
    }),
  ).rejects.toThrow("freeze mismatch");
  const altered = structuredClone(result);
  const row = altered.rows[0];
  if (row === undefined) throw new Error("missing row");
  row.selection.selectedCandidate = "candidate-3";
  await expect(
    evaluateTddExtensions({ benchmarkPath, previous: altered }),
  ).rejects.toThrow("selection replay mismatch");
}, 30000);
test("refuses changed or escaping frozen inputs before evaluation", async () => {
  const parent = resolve(import.meta.dir, "../.semantic/test-workspaces");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "extension-freeze-"));
  try {
    await cp(resolve(benchmarkPath, ".."), root, { recursive: true });
    await writeFile(resolve(root, "permissions.hidden.json"), "[]");
    await expect(
      evaluateTddExtensions({ benchmarkPath: resolve(root, "benchmark.json") }),
    ).rejects.toThrow("input changed");
    const freeze = JSON.parse(
      await readFile(resolve(root, "freeze.json"), "utf8"),
    );
    freeze.files = { "../escape": "a".repeat(64) };
    await writeFile(resolve(root, "freeze.json"), JSON.stringify(freeze));
    await expect(
      evaluateTddExtensions({ benchmarkPath: resolve(root, "benchmark.json") }),
    ).rejects.toThrow("inside");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("live evaluation refuses unspecified declared prices", async () => {
  await expect(
    evaluateTddExtensions({
      benchmarkPath,
      model: "explicit-model",
      config: {
        ...result.config,
        inputUsdPerMillionTokens: 0.000001,
        outputUsdPerMillionTokens: 0,
      },
    }),
  ).rejects.toThrow();
});

test("live resource stops retain the response audit and replay without a provider", async () => {
  let calls = 0;
  const stopped = await evaluateTddExtensions({
    benchmarkPath,
    model: "mock-model",
    config: { ...result.config, maxTotalTokens: 2 },
    resolve: async () => {
      calls++;
      return {
        elaboration: { outcome: "unresolved", body: null, diagnostics: [] },
        rawOutput: { test: true },
        response: {
          responseId: "mock",
          model: "mock-model",
          outputText: "{}",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      };
    },
  });
  expect(calls).toBe(1);
  expect(stopped.status).toBe("resource-stopped");
  expect(stopped.stopReason).toBe("total-token-budget");
  expect(stopped.rows).toHaveLength(1);
  expect(stopped.apiCalls).toBe(1);
  expect(stopped.totalTokens).toBe(3);
  expect(stopped.rows[0]?.selection.trials[0]?.rawOutput).toEqual({
    test: true,
  });
  expect(
    await evaluateTddExtensions({ benchmarkPath, previous: stopped }),
  ).toEqual(stopped);
  const altered = structuredClone(stopped);
  altered.config.maxTotalTokens = 1000;
  await expect(
    evaluateTddExtensions({ benchmarkPath, previous: altered }),
  ).rejects.toThrow("resource configuration mismatch");
}, 30000);

test("retains completed rows when the remaining cost is below the next valid budget", async () => {
  let calls = 0;
  const stopped = await evaluateTddExtensions({
    benchmarkPath,
    model: "mock-model",
    config: { ...result.config, maxCostUsd: 0.0000035 },
    resolve: async () => {
      calls++;
      return {
        elaboration: { outcome: "unresolved", body: null, diagnostics: [] },
        rawOutput: null,
        response: {
          responseId: "mock",
          model: "mock-model",
          outputText: "{}",
          usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        },
      };
    },
  });
  expect(calls).toBe(3);
  expect(stopped.status).toBe("resource-stopped");
  expect(stopped.stopReason).toBe("evaluation total resource budget exhausted");
  expect(stopped.rows).toHaveLength(1);
  expect(
    await evaluateTddExtensions({ benchmarkPath, previous: stopped }),
  ).toEqual(stopped);
}, 30000);

test("later budget failure does not invalidate the first-draw baseline", async () => {
  const candidates = JSON.parse(
    await readFile(
      resolve(benchmarkPath, "../permissions-correct-first.candidates.json"),
      "utf8",
    ),
  );
  let calls = 0;
  const report = await evaluateTddExtensions({
    benchmarkPath,
    model: "mock-model",
    config: { ...result.config, maxTotalTokens: 3 },
    resolve: async () => ({
      elaboration: candidates[0],
      rawOutput: candidates[0],
      response: {
        responseId: "mock",
        model: "mock-model",
        outputText: "{}",
        usage: {
          inputTokens: ++calls === 1 ? 1 : 3,
          outputTokens: 0,
          totalTokens: calls === 1 ? 1 : 3,
        },
      },
    }),
  });
  expect(report.status).toBe("resource-stopped");
  expect(report.rows[0]?.single.unresolved).toBe(false);
  expect(report.rows[0]?.single.checked).toBe(16);
  expect(report.rows[0]?.bestOfN.unresolved).toBe(true);
  expect(
    await evaluateTddExtensions({ benchmarkPath, previous: report }),
  ).toEqual(report);
}, 30000);

test("evaluation uses frozen snapshots when a provider changes held-out files", async () => {
  const parent = resolve(import.meta.dir, "../benchmarks");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "extension-snapshot-"));
  try {
    await cp(resolve(benchmarkPath, ".."), root, { recursive: true });
    const candidates = JSON.parse(
      await readFile(
        resolve(root, "permissions-correct-first.candidates.json"),
        "utf8",
      ),
    );
    const report = await evaluateTddExtensions({
      benchmarkPath: resolve(root, "benchmark.json"),
      model: "mock-model",
      config: { ...result.config, maxTotalTokens: 1 },
      resolve: async () => {
        await writeFile(resolve(root, "permissions.hidden.json"), "[]");
        return {
          elaboration: candidates[0],
          rawOutput: candidates[0],
          response: {
            responseId: "mock",
            model: "mock-model",
            outputText: "{}",
            usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          },
        };
      },
    });
    expect(report.rows[0]?.single.checked).toBe(16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("rejects untrusted evaluation metadata before replay", async () => {
  for (const change of [
    { lane: "unknown" },
    { model: "invented" },
    { rows: [{ ...result.rows[0], latencyMs: -1 }] },
  ]) {
    await expect(
      evaluateTddExtensions({
        benchmarkPath,
        previous: { ...result, ...change } as ExtensionEvaluation,
      }),
    ).rejects.toThrow();
  }
});

test("CLI refuses an existing destination before loading inputs or calling providers", async () => {
  const parent = resolve(import.meta.dir, "../.semantic/test-workspaces");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "extension-output-"));
  try {
    const output = resolve(root, "existing.json");
    await writeFile(output, "preserved");
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "semantic-tdd-extension-evaluation.ts"),
        "live",
        "missing-benchmark.json",
        output,
        "mock-model",
        "missing-budget.json",
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, OPENAI_API_KEY: "" },
      },
    );
    const error = new Response(child.stderr).text();
    expect(await child.exited).toBe(2);
    expect(await error).toContain("EEXIST");
    expect(await readFile(output, "utf8")).toBe("preserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selection evidence is checkpointed before post-selection analysis", async () => {
  const checkpoints: unknown[] = [];
  const report = await evaluateTddExtensions({
    benchmarkPath,
    model: "mock-model",
    config: { ...result.config, maxTotalTokens: 1 },
    resolve: async () => ({
      elaboration: null,
      rawOutput: { retained: true },
      response: {
        responseId: "mock",
        model: "mock-model",
        outputText: "bad",
        usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
      },
    }),
    onSelection: async (selection) => {
      checkpoints.push(structuredClone(selection));
    },
  });
  expect(checkpoints).toEqual(report.rows.map((row) => row.selection));
  const parent = resolve(import.meta.dir, "../.semantic/test-workspaces");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "extension-stopped-cli-"));
  try {
    const output = resolve(root, "stopped.json");
    await writeFile(output, JSON.stringify(report));
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "semantic-tdd-extension-evaluation.ts"),
        "replay",
        benchmarkPath,
        output,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(await stdout).toContain('"status": "resource-stopped"');
    expect(await stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
