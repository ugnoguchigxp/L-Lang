import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  developLlangCapability,
  fixtureLlangAgent,
  replayLlangDevelopment,
} from "./llang-development";
import { migratePromptSource } from "./llang-migrate";
import { createLlangCapabilityFixture } from "./llang-test-fixture";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length)
    await rm(roots.pop() as string, { recursive: true, force: true });
});

describe("L-Lang Development and migration", () => {
  test("fixture repair passes and replay reproduces the hashes", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const good = JSON.parse(
      (await readFile(f.source, "utf8"))
        .replace(/\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1"),
    );
    const bad = structuredClone(good);
    bad.body.conditions = [bad.body.conditions[0]];
    const reply = (program: unknown, id: string) => ({
      result: { outcome: "generated", program, diagnostics: [] },
      provider: "fixture",
      model: "fixture",
      responseId: id,
      usage: null,
    });
    const run = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      {
        version: 2,
        mode: "fixture",
        model: "fixture",
        maxCalls: 2,
        maxOutputTokens: 4096,
        maxTotalTokens: 100000,
        maxWallMs: 120000,
      },
      fixtureLlangAgent({
        version: 2,
        responses: [
          { stage: "implementation", reply: reply(bad, "one") },
          { stage: "repair", reply: reply(good, "two") },
        ],
      }),
      resolve(f.root, "run"),
    );
    expect(run.status).toBe("pass");
    const replay = await replayLlangDevelopment(
      resolve(f.root, "run"),
      resolve(f.root, "replay"),
    );
    expect(replay.status).toBe("pass");
  });

  test("development records failed calls and replay reproduces the failure", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const output = resolve(f.root, "failed-run");
    const run = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      {
        version: 2,
        mode: "fixture",
        model: "fixture",
        maxCalls: 2,
        maxOutputTokens: 4096,
        maxTotalTokens: 100000,
        maxWallMs: 120000,
      },
      async () => {
        throw new Error("fixture transport failed");
      },
      output,
    );
    expect(run).toMatchObject({
      status: "error",
      logicalCalls: 1,
      calls: [{ reply: null, error: "fixture transport failed" }],
    });
    expect(
      (await replayLlangDevelopment(output, resolve(f.root, "failed-replay")))
        .status,
    ).toBe("error");
    const changedSuite = { ...f.suite, cases: [...f.suite.cases].reverse() };
    await writeFile(
      resolve(output, "tests.json"),
      JSON.stringify(changedSuite),
    );
    await expect(
      replayLlangDevelopment(output, resolve(f.root, "tampered-replay")),
    ).rejects.toThrow("snapshot hash mismatch");
  });

  test("development validates metadata before creating its output", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const output = resolve(f.root, "invalid-metadata");
    await expect(
      developLlangCapability(
        f.request,
        f.suite,
        { ...f.metadata, id: "other" },
        {
          version: 2,
          mode: "fixture",
          model: "fixture",
          maxCalls: 1,
          maxOutputTokens: 4096,
          maxTotalTokens: 100000,
          maxWallMs: 120000,
        },
        async () => {
          throw new Error("must not run");
        },
        output,
      ),
    ).rejects.toThrow("metadata id differs");
    await expect(access(output)).rejects.toThrow();
  });

  test("development stops repeated candidates and terminal unresolved replies", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const good = JSON.parse(
      (await readFile(f.source, "utf8"))
        .replace(/\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1"),
    );
    const bad = structuredClone(good);
    bad.body.conditions = [bad.body.conditions[0]];
    const reply = (program: unknown, id: string) => ({
      result: { outcome: "generated", program, diagnostics: [] },
      provider: "fixture",
      model: "fixture",
      responseId: id,
      usage: null,
    });
    const repeated = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      {
        version: 2,
        mode: "fixture",
        model: "fixture",
        maxCalls: 2,
        maxOutputTokens: 4096,
        maxTotalTokens: 100000,
        maxWallMs: 120000,
      },
      fixtureLlangAgent({
        version: 2,
        responses: [
          { stage: "implementation", reply: reply(bad, "same-one") },
          { stage: "repair", reply: reply(bad, "same-two") },
        ],
      }),
      resolve(f.root, "repeated-run"),
    );
    expect(repeated).toMatchObject({
      status: "stopped",
      logicalCalls: 2,
      stopReason: "same Program resubmitted",
    });

    const unresolved = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      {
        version: 2,
        mode: "fixture",
        model: "fixture",
        maxCalls: 1,
        maxOutputTokens: 4096,
        maxTotalTokens: 100000,
        maxWallMs: 120000,
      },
      fixtureLlangAgent({
        version: 2,
        responses: [
          {
            stage: "implementation",
            reply: {
              result: {
                outcome: "unresolved",
                program: null,
                diagnostics: ["requirements are ambiguous"],
              },
              provider: "fixture",
              model: "fixture",
              responseId: "unresolved",
              usage: null,
            },
          },
        ],
      }),
      resolve(f.root, "unresolved-run"),
    );
    expect(unresolved).toMatchObject({
      status: "unresolved",
      stopReason: "requirements are ambiguous",
    });
  });

  test("development enforces wall, token and immutable-input limits", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const base = {
      version: 2 as const,
      mode: "fixture" as const,
      model: "fixture",
      maxCalls: 1 as const,
      maxOutputTokens: 4096,
      maxTotalTokens: 100000,
      maxWallMs: 5,
    };
    const timed = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      base,
      async (_request, signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      resolve(f.root, "timed-run"),
    );
    expect(timed).toMatchObject({ status: "stopped" });
    expect(String(timed.stopReason)).toContain("deadline");

    const noBudget = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      {
        ...base,
        mode: "live",
        model: "test-live",
        maxWallMs: 120000,
        maxTotalTokens: 1,
      },
      async () => {
        throw new Error("must not call");
      },
      resolve(f.root, "budget-run"),
    );
    expect(noBudget).toMatchObject({
      status: "stopped",
      logicalCalls: 0,
      apiCalls: 0,
    });
    expect(String(noBudget.stopReason)).toContain("token budget");

    const good = JSON.parse(
      (await readFile(f.source, "utf8"))
        .replace(/\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1"),
    );
    const missingUsage = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      {
        ...base,
        mode: "live",
        model: "test-live",
        maxWallMs: 120000,
      },
      async () => ({
        result: { outcome: "generated", program: good, diagnostics: [] },
        provider: "fixture",
        model: "test-live",
        responseId: "missing-usage",
        usage: null,
      }),
      resolve(f.root, "missing-usage-run"),
    );
    expect(missingUsage).toMatchObject({
      status: "stopped",
      logicalCalls: 1,
      apiCalls: 1,
    });
    expect(String(missingUsage.stopReason)).toContain("live usage missing");

    const changedRoot = resolve(f.root, "changed-input-run");
    const changed = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      { ...base, maxWallMs: 120000 },
      async () => {
        await writeFile(resolve(changedRoot, "request.json"), "{}");
        return {
          result: { outcome: "generated", program: good, diagnostics: [] },
          provider: "fixture",
          model: "fixture",
          responseId: "changed-input",
          usage: null,
        };
      },
      changedRoot,
    );
    expect(changed).toMatchObject({ status: "error" });
    expect(String(changed.stopReason)).toContain(
      "fixed development inputs changed",
    );
  });

  test("development rejects malformed replies and invalid configuration", async () => {
    const f = await createLlangCapabilityFixture(roots);
    await expect(
      developLlangCapability(
        f.request,
        f.suite,
        f.metadata,
        {
          version: 2,
          mode: "fixture",
          model: "fixture",
          maxCalls: 1,
          maxOutputTokens: 1,
          maxTotalTokens: 100000,
          maxWallMs: 120000,
        },
        async () => {
          throw new Error("must not call");
        },
        resolve(f.root, "invalid-config"),
      ),
    ).rejects.toThrow("invalid L-Lang development config");

    const malformed = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      {
        version: 2,
        mode: "fixture",
        model: "fixture",
        maxCalls: 1,
        maxOutputTokens: 4096,
        maxTotalTokens: 100000,
        maxWallMs: 120000,
      },
      async () => ({
        result: { outcome: "generated", program: null, diagnostics: [] },
        provider: "fixture",
        model: "fixture",
        responseId: "malformed",
        usage: null,
      }),
      resolve(f.root, "malformed-run"),
    );
    expect(malformed).toMatchObject({ status: "error" });
    expect(String(malformed.stopReason)).toContain(
      "invalid agent program response",
    );
  });

  test("legacy migration requires a valid lock and emits source, request and tests", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "llang-migrate-"));
    roots.push(root);
    const output = resolve(root, "active.llang.jsonc");
    const result = await migratePromptSource(
      resolve(
        process.cwd(),
        "examples/prompt-active-customer/customer.prompt.json",
      ),
      output,
    );
    expect(await readFile(result.source, "utf8")).toContain(
      '"language": "l-lang"',
    );
    expect(JSON.parse(await readFile(result.request, "utf8")).version).toBe(2);
    await expect(
      migratePromptSource(
        resolve(
          process.cwd(),
          "examples/prompt-active-customer/customer.prompt.json",
        ),
        output,
      ),
    ).rejects.toThrow();
    await expect(
      migratePromptSource(
        resolve(
          process.cwd(),
          "examples/prompt-active-customer/customer.prompt.json",
        ),
        resolve(root, "wrong-extension.json"),
      ),
    ).rejects.toThrow("must use .llang.jsonc");
  });

  test("migration rejects missing, malformed and stale legacy locks", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "llang-bad-migrate-"));
    roots.push(root);
    const original = resolve(
      process.cwd(),
      "examples/prompt-active-customer/customer.prompt.json",
    );
    const source = resolve(root, "legacy.prompt.json");
    await copyFile(original, source);
    await expect(
      migratePromptSource(source, resolve(root, "missing.llang.jsonc")),
    ).rejects.toThrow();

    await writeFile(`${source}.lock.json`, "{}");
    await expect(
      migratePromptSource(source, resolve(root, "malformed.llang.jsonc")),
    ).rejects.toThrow();

    await copyFile(`${original}.lock.json`, `${source}.lock.json`);
    const changed = JSON.parse(await readFile(source, "utf8"));
    changed.intent = `${changed.intent} changed`;
    await writeFile(source, JSON.stringify(changed));
    await expect(
      migratePromptSource(source, resolve(root, "stale.llang.jsonc")),
    ).rejects.toThrow();
  });
});
