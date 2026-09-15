import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runCapabilityCli } from "./capability-cli";
import {
  developCapability,
  fixtureConfig,
  fixtureDevelopmentAgent,
  parseDevelopmentConfig,
  parseDevelopmentRun,
  replayDevelopment,
} from "./capability-development";
import {
  checkCapabilityMutations,
  compareMutation,
  enumerateObservations,
  generateMutations,
} from "./capability-mutation";
import { readCapability } from "./capability-package";
import {
  type DevelopmentAgent,
  parseGeneratedTests,
  testGenerationRequest,
} from "./capability-test-agent";
import type { PredicateExpression } from "./ir";
import { contentHash, parsePromptSource, readJson } from "./prompt-source";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function setup(name = "access") {
  const root = await mkdtemp(resolve(tmpdir(), "cap-development-"));
  roots.push(root);
  const example = resolve(
    import.meta.dir,
    "../examples/capability-development",
    name,
  );
  const source = parsePromptSource(
    await readJson(resolve(example, "source.json")),
  );
  const metadata = await readJson(resolve(example, "metadata.json"));
  const fixtures = JSON.parse(
    await readFile(resolve(example, "responses.fixture.json"), "utf8"),
  );
  return {
    root,
    example,
    source,
    metadata,
    fixtures,
    out: resolve(root, "run"),
  };
}
async function run(
  f: Awaited<ReturnType<typeof setup>>,
  agent = fixtureDevelopmentAgent(f.fixtures),
  config = fixtureConfig,
) {
  return developCapability(f.source, f.metadata, config, agent, f.out);
}

describe("Coding Agent development", () => {
  test.each(["access", "contact", "logic"])(
    "%s: fixed tests detect initial defect, one repair passes and replay matches",
    async (name) => {
      const f = await setup(name);
      const requests: Parameters<DevelopmentAgent>[0][] = [];
      const agent = fixtureDevelopmentAgent(f.fixtures);
      const report = await run(f, async (request) => {
        requests.push(request);
        return agent(request);
      });
      expect(report.status).toBe("pass");
      expect(report.attempts.map((a) => a.status)).toEqual(["fail", "pass"]);
      expect(report.logicalCalls).toBe(3);
      expect(report.apiCalls).toBe(0);
      expect(report.acceptance).toBe("not-run");
      expect(requests[0]?.input).not.toHaveProperty("examples");
      expect(requests[0]?.input).not.toHaveProperty("body");
      expect(requests[1]?.input).not.toHaveProperty("suite");
      expect(requests[1]?.input).not.toHaveProperty("examples");
      expect(requests[2]?.input).toHaveProperty("previous.failures");
      const saved = await readJson(resolve(f.out, "run.json"));
      expect(parseDevelopmentRun(saved)).toEqual(report);
      const replay = await replayDevelopment(f.out, resolve(f.root, "replay"));
      expect(replay.status).toBe("pass");
      expect(replay.attempts).toEqual(report.attempts);
      expect(replay.suiteHash).toBe(report.suiteHash);
      expect(replay.apiCalls).toBe(0);
      await expect(run(f)).rejects.toThrow();
    },
    30000,
  );
  test("test suite contradictions are detected without treating undefined as omission", async () => {
    const f = await setup("contact");
    const reply = f.fixtures.responses[0].reply.result;
    expect(parseGeneratedTests(reply, f.source).outcome).toBe("generated");
    const suite = JSON.parse(reply.suiteJson);
    suite.cases.push({
      ...suite.cases[0],
      id: "contradict",
      input: { email: "x", tier: "premium" },
      expected: { kind: "value", value: false },
    });
    expect(() =>
      parseGeneratedTests(
        { ...reply, suiteJson: JSON.stringify(suite) },
        f.source,
      ),
    ).toThrow("contradict");
    const output = await run(f, async () => ({
      ...f.fixtures.responses[0].reply,
      result: { ...reply, suiteJson: JSON.stringify(suite) },
    }));
    expect(output.status).toBe("error");
    expect(output.logicalCalls).toBe(1);
    expect(output.attempts).toEqual([]);
  });
  test.each(["unresolved", "error"])(
    "test generator %s is terminal",
    async (outcome) => {
      const f = await setup();
      f.fixtures.responses[0].reply.result = {
        outcome,
        suiteJson: null,
        diagnostics: ["requirements unclear"],
      };
      const output = await run(f);
      expect(output.status).toBe(outcome);
      expect(output.logicalCalls).toBe(1);
      expect(() =>
        parseGeneratedTests(
          { outcome, suiteJson: "{}", diagnostics: [] },
          f.source,
        ),
      ).toThrow();
    },
  );
  test("malformed response is persisted and cannot fabricate a candidate", async () => {
    const f = await setup();
    const output = await run(f, async () => ({
      ...f.fixtures.responses[0].reply,
      unexpected: true,
    }));
    expect(output.status).toBe("error");
    expect(output.calls[0]?.response).toHaveProperty("unexpected");
    expect(output.calls[0]?.reply).toBeNull();
  });
  test("same IR stops after one repair instead of weakening tests", async () => {
    const f = await setup();
    f.fixtures.responses[2].reply = f.fixtures.responses[1].reply;
    const result = await run(f);
    expect(result.status).toBe("stopped");
    expect(result.stopReason).toContain("same IR");
    expect(result.attempts).toHaveLength(1);
  });
  test("second different but wrong candidate is a terminal fail", async () => {
    const f = await setup();
    f.fixtures.responses[2].reply.result.body = {
      kind: "all",
      conditions: [
        f.fixtures.responses[1].reply.result.body,
        f.fixtures.responses[1].reply.result.body,
      ],
    };
    const result = await run(f);
    expect(result.status).toBe("fail");
    expect(result.attempts).toHaveLength(2);
    expect(result.logicalCalls).toBe(3);
  });
  test("unresolved implementation and invalid repair cannot alter the specification", async () => {
    const f = await setup();
    f.fixtures.responses[1].reply.result = {
      outcome: "unresolved",
      body: null,
      diagnostics: ["ambiguous"],
    };
    expect((await run(f)).status).toBe("unresolved");
    const g = await setup();
    g.fixtures.responses[2].reply.result.source = { intent: "changed" };
    expect((await run(g)).status).toBe("error");
  });
  test("call cap and insufficient live token budget stop before dispatch", async () => {
    const f = await setup();
    expect(
      (
        await run(f, fixtureDevelopmentAgent(f.fixtures), {
          ...fixtureConfig,
          maxCalls: 2,
        })
      ).logicalCalls,
    ).toBe(2);
    const g = await setup();
    let calls = 0;
    const result = await run(
      g,
      async () => {
        calls++;
        throw Error("must not dispatch");
      },
      { ...fixtureConfig, mode: "live", maxTotalTokens: 1 },
    );
    expect(result.status).toBe("stopped");
    expect(calls).toBe(0);
    expect(result.apiCalls).toBe(0);
  });
  test.each(["missing", "exceeded", "refused"])(
    "live %s usage retains a stop record",
    async (kind) => {
      const f = await setup();
      const reply = f.fixtures.responses[0].reply;
      if (kind === "exceeded")
        reply.usage = {
          inputTokens: 900000,
          outputTokens: 0,
          totalTokens: 900000,
        };
      const result = await run(
        f,
        async () => {
          if (kind === "refused") throw new Error("model refused");
          return reply;
        },
        { ...fixtureConfig, mode: "live" },
      );
      expect(["stopped", "error"]).toContain(result.status);
      expect(result.logicalCalls).toBe(1);
      expect(result.apiCalls).toBe(1);
      expect(result.usedTokens).toBeGreaterThan(0);
    },
  );
  test("live mock success accounts usage without extra retries", async () => {
    const f = await setup();
    for (const r of f.fixtures.responses)
      r.reply.usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    const result = await run(f, fixtureDevelopmentAgent(f.fixtures), {
      ...fixtureConfig,
      mode: "live",
    });
    expect(result.status).toBe("pass");
    expect(result.usedTokens).toBe(90);
    expect(result.apiCalls).toBe(3);
    const replay = await replayDevelopment(f.out, resolve(f.root, "replay"));
    expect(replay.status).toBe("pass");
    expect(replay.apiCalls).toBe(0);
  });
  test("wall-clock limit aborts a pending call and preserves incomplete checkpoint while running", async () => {
    const f = await setup();
    let aborted = false;
    const result = await run(
      f,
      async (_, signal) => {
        const checkpoint = parseDevelopmentRun(
          await readJson(resolve(f.out, "run.json")),
        );
        expect(checkpoint.complete).toBe(false);
        await expect(
          replayDevelopment(f.out, resolve(f.root, "premature")),
        ).rejects.toThrow();
        return new Promise((_, reject) =>
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(Error("aborted"));
            },
            { once: true },
          ),
        );
      },
      { ...fixtureConfig, maxWallMs: 500 },
    );
    expect(result.status).toBe("stopped");
    expect(aborted).toBe(true);
  });
  test("agent-side modifications of fixed inputs stop the run", async () => {
    const f = await setup();
    const agent = fixtureDevelopmentAgent(f.fixtures);
    const result = await run(f, async (request) => {
      if (request.stage === "repair")
        await writeFile(resolve(f.out, "tests.json"), "{}");
      return agent(request);
    });
    expect(result.status).toBe("error");
    expect(result.stopReason).toContain("fixed development inputs changed");
  });
  test("replay rejects modified snapshots, checksums, and symlinked inputs", async () => {
    const f = await setup();
    await run(f);
    await writeFile(resolve(f.out, "tests.json"), "{}");
    await expect(
      replayDevelopment(f.out, resolve(f.root, "replay")),
    ).rejects.toThrow("hash");
    const g = await setup();
    await run(g);
    const saved = JSON.parse(
      await readFile(resolve(g.out, "run.json"), "utf8"),
    );
    expect(() => parseDevelopmentRun({ ...saved, complete: false })).toThrow();
    saved.logicalCalls = 99;
    const { checksum: _, ...unsigned } = saved;
    saved.checksum = contentHash(unsigned);
    expect(() => parseDevelopmentRun(saved)).toThrow();
    await rm(resolve(g.out, "source.json"));
    await symlink(
      resolve(g.example, "source.json"),
      resolve(g.out, "source.json"),
    );
    await expect(
      replayDevelopment(g.out, resolve(g.root, "replay")),
    ).rejects.toThrow();
  });
  test("configuration, fixture shape and strict test response validation", async () => {
    const f = await setup();
    for (const patch of [
      { mode: "unknown" },
      { maxCalls: 4 },
      { maxOutputTokens: 1 },
      { maxWallMs: 0 },
      { model: "" },
      { extra: 1 },
    ])
      expect(() =>
        parseDevelopmentConfig({ ...fixtureConfig, ...patch }),
      ).toThrow();
    expect(() =>
      fixtureDevelopmentAgent({
        version: 1,
        responses: [{ stage: "unknown", reply: {} }],
      }),
    ).toThrow();
    const request = testGenerationRequest(f.source);
    expect(request.input).not.toHaveProperty("examples");
    const invalids = [
      { outcome: "generated", suiteJson: "{}", diagnostics: [] },
      { outcome: "generated", suiteJson: null, diagnostics: [] },
      {
        outcome: "generated",
        suiteJson: "x".repeat(1024 * 1024 + 1),
        diagnostics: [],
      },
    ];
    for (const value of invalids)
      expect(() => parseGeneratedTests(value, f.source)).toThrow();
    const agent = fixtureDevelopmentAgent({ version: 1, responses: [] });
    await expect(agent(request)).rejects.toThrow();
  });
});

describe("mutation evidence", () => {
  test("strong tests kill a missing condition; weak tests report a surviving non-equivalent mutant", async () => {
    const f = await setup();
    await run(f);
    const report = await checkCapabilityMutations(
      resolve(f.out, "attempt-1/candidate/capability.json"),
    );
    expect(report.counts["killed-suite"]).toBeGreaterThan(0);
    expect(report.counts.survived).toBe(0);
    const g = await setup();
    const suite = JSON.parse(g.fixtures.responses[0].reply.result.suiteJson);
    suite.cases = g.source.examples.map((e) => ({
      ...e,
      requirementIds: g.source.requirements.map((r) => r.id),
      expected: { kind: "value", value: e.expected },
    }));
    g.fixtures.responses[0].reply.result.suiteJson = JSON.stringify(suite);
    g.fixtures.responses[1].reply = g.fixtures.responses[2].reply;
    expect((await run(g)).status).toBe("pass");
    const weak = await checkCapabilityMutations(
      resolve(g.out, "attempt-0/candidate/capability.json"),
    );
    expect(weak.counts.survived).toBeGreaterThan(0);
    expect(
      weak.results.find((r) => r.status === "survived")?.counterexample,
    ).not.toBeNull();
  }, 30000);
  test("equivalent mutants and truncated observation domains are not called errors", async () => {
    const f = await setup();
    const a: PredicateExpression = {
      kind: "equals",
      property: ["enabled"],
      value: true,
    };
    expect(
      compareMutation(f.source, { kind: "all", conditions: [a, a] }, a)
        .relation,
    ).toBe("equivalent");
    const fields = Array.from({ length: 13 }, (_, i) => ({
      name: `f${String(i).padStart(2, "0")}`,
      kind: "boolean" as const,
      values: [],
      optional: false,
      nullable: false,
      undefinable: false,
    }));
    const source = { ...f.source, contract: { version: 1 as const, fields } };
    const first: PredicateExpression = {
      kind: "equals",
      property: ["f00"],
      value: true,
    };
    const other: PredicateExpression = {
      kind: "all",
      conditions: [first, { kind: "equals", property: ["f01"], value: true }],
    };
    expect(enumerateObservations(source.contract).exhaustive).toBe(false);
    expect(compareMutation(source, first, other).relation).toBe("unknown");
    const generated = generateMutations(
      { kind: "all", conditions: Array(40).fill(a) },
      f.source.contract,
    );
    expect(generated.mutations.length).toBeLessThanOrEqual(32);
    expect(generated.omittedProposals).toBeGreaterThan(0);
  });
  test("contact and logic operations use only legal finite observations", async () => {
    for (const name of ["contact", "logic"]) {
      const f = await setup(name);
      await run(f);
      const path = resolve(f.out, "attempt-1/candidate/capability.json");
      const report = await checkCapabilityMutations(path);
      expect(report.counts.error).toBe(0);
      expect(report.complete).toBe(true);
      expect((await readCapability(path)).packageHash).toBe(report.packageHash);
    }
  }, 30000);
  test("CLI develops, mutates, replays, and rejects invalid combinations", async () => {
    const f = await setup();
    const args = [
      "develop",
      resolve(f.example, "source.json"),
      "--metadata",
      resolve(f.example, "metadata.json"),
      "--fixtures",
      resolve(f.example, "responses.fixture.json"),
      "--out-dir",
      f.out,
    ];
    expect((await runCapabilityCli(args)).exitCode).toBe(0);
    expect(
      (
        await runCapabilityCli([
          "mutation-check",
          resolve(f.out, "attempt-1/candidate/capability.json"),
          "--report",
          resolve(f.root, "mutation.json"),
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runCapabilityCli([
          "replay-development",
          f.out,
          "--out-dir",
          resolve(f.root, "replay"),
        ])
      ).exitCode,
    ).toBe(0);
    for (const bad of [
      [...args, "--model", "fake"],
      [...args, "--bad", "x"],
      [
        "develop",
        resolve(f.example, "source.json"),
        "--metadata",
        resolve(f.example, "metadata.json"),
        "--out-dir",
        resolve(f.root, "live"),
      ],
      ["mutation-check", "x"],
    ])
      await expect(runCapabilityCli(bad)).rejects.toThrow();
  }, 30000);
});

test("live CLI adapter works against a local fake Responses server and can replay offline", async () => {
  const f = await setup();
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        store: boolean;
        max_output_tokens: number;
        input: unknown;
      };
      expect(body.store).toBe(false);
      expect(body.max_output_tokens).toBe(4096);
      const reply = f.fixtures.responses[calls++].reply;
      return Response.json({
        id: `local-${calls}`,
        model: "local-test-model",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: JSON.stringify(reply.result) },
            ],
          },
        ],
      });
    },
  });
  try {
    const p = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "capability-cli.ts"),
        "develop",
        resolve(f.example, "source.json"),
        "--metadata",
        resolve(f.example, "metadata.json"),
        "--out-dir",
        f.out,
        "--model",
        "local-test-model",
        "--max-output-tokens",
        "4096",
        "--max-total-tokens",
        "1000000",
        "--max-wall-ms",
        "120000",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OPENAI_API_KEY: "local-fake-key",
          OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout).status).toBe("pass");
    expect(calls).toBe(3);
    const replay = await replayDevelopment(f.out, resolve(f.root, "replay"));
    expect(replay.status).toBe("pass");
    expect(replay.apiCalls).toBe(0);
  } finally {
    await server.stop(true);
  }
}, 30000);

test("Responses requests respect cancellation without waiting for the transport timeout", async () => {
  const { callResponsesApi } = await import("./openai");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Promise<Response>((resolveResponse) =>
        setTimeout(() => resolveResponse(Response.json({})), 100),
      );
    },
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(
      callResponsesApi(
        {},
        {
          provider: "openai",
          baseUrl: `http://127.0.0.1:${server.port}`,
          apiKey: "fake",
          authMode: "bearer",
        },
        controller.signal,
      ),
    ).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});

test("equivalent condition removals appear in the mutation report", async () => {
  const f = await setup();
  const body = f.fixtures.responses[2].reply.result.body;
  f.fixtures.responses[1].reply.result.body = {
    ...body,
    conditions: [...body.conditions, body.conditions[1]],
  };
  expect((await run(f)).status).toBe("pass");
  const report = await checkCapabilityMutations(
    resolve(f.out, "attempt-0/candidate/capability.json"),
  );
  expect(report.counts.equivalent).toBeGreaterThan(0);
  expect(
    report.results
      .filter((r) => r.status === "equivalent")
      .every((r) => r.counterexample === null),
  ).toBe(true);
});

test("oversized generation requests stop before calling the agent", async () => {
  const f = await setup();
  f.source.requirements = Array.from({ length: 20 }, (_, i) => ({
    id: `r${i}`,
    level: "must",
    text: "x".repeat(4000),
  }));
  let calls = 0;
  const result = await run(f, async () => {
    calls++;
    throw Error("unexpected dispatch");
  });
  expect(result.status).toBe("stopped");
  expect(calls).toBe(0);
  expect(result.stopReason).toContain("input reservation");
});

test("replay compares regenerated candidates with the recorded evidence", async () => {
  const f = await setup();
  await run(f);
  const saved = JSON.parse(await readFile(resolve(f.out, "run.json"), "utf8"));
  saved.attempts[1].packageHash = "0".repeat(64);
  const { checksum: _, ...unsigned } = saved;
  saved.checksum = contentHash(unsigned);
  await writeFile(resolve(f.out, "run.json"), JSON.stringify(saved));
  const replay = await replayDevelopment(f.out, resolve(f.root, "replay"));
  expect(replay.status).toBe("error");
  expect(replay.stopReason).toContain("differs from recorded");
});
