import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveOpenAIConnection } from "./openai";
import {
  makeOpenAIAgent,
  makePromptResolver,
  proposeMeaning,
  proposePatch,
} from "./prompt-agent";
import { runPromptCli } from "./prompt-cli";
import {
  type PromptResolver,
  parseResolutionLock,
  readPromptResolution,
  resolvePromptSource,
} from "./prompt-resolution";
import {
  contentHash,
  createPromptSource,
  parsePromptSource,
  readJson,
  readPromptSource,
  updatePromptSource,
} from "./prompt-source";
import { buildPromptWasm, inspectPrompt, testPromptWasm } from "./prompt-wasm";

const example = resolve(import.meta.dir, "../examples/prompt-active-customer");
const candidate = await readJson(resolve(example, "customer.prompt.json"));
const resolution = await readJson(resolve(example, "resolution.fixture.json"));
const patch = await readJson(resolve(example, "patch.fixture.json"));
const reply = {
  result: resolution,
  provider: "fixture",
  model: "fixture",
  responseId: "fixture",
  usage: null,
};
const resolver: PromptResolver = async () => reply;
async function fixture(run: (path: string, root: string) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), "llang-prompt-"));
  const path = resolve(root, "customer.prompt.json");
  try {
    await createPromptSource(path, candidate);
    await run(path, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
describe("Prompt Source and Resolution Lock", () => {
  test("validates schema, duplicate IDs, examples and execution profile", () => {
    const s = parsePromptSource(candidate);
    for (const changes of [
      { unexpected: true },
      { profile: "memory" },
      { examples: [] },
      { requirements: [...s.requirements, s.requirements[0]] },
      {
        examples: [
          { ...s.examples[0], input: { wrong: true } },
          ...s.examples.slice(1),
        ],
      },
    ])
      expect(() => parsePromptSource({ ...s, ...changes })).toThrow();
    expect(contentHash(s)).toBe(contentHash(JSON.parse(JSON.stringify(s))));
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });
  test("exclusive creation and scoped CAS preserve other requirements and tests", () =>
    fixture(async (path) => {
      await expect(createPromptSource(path, candidate)).rejects.toThrow();
      const before = await readPromptSource(path);
      await expect(
        updatePromptSource(path, before.revision, ["has-email"], patch),
      ).rejects.toThrow("allowed");
      const next = await updatePromptSource(
        path,
        before.revision,
        ["active"],
        patch,
      );
      expect(next.source.requirements.slice(1)).toEqual(
        before.source.requirements.slice(1),
      );
      expect(next.source.examples).toEqual(before.source.examples);
      expect(next.source.contract).toEqual(before.source.contract);
      expect(next.revision).not.toBe(before.revision);
      await expect(
        updatePromptSource(path, before.revision, ["active"], patch),
      ).rejects.toThrow("revision");
    }));
  test("concurrent source writers cannot both commit", () =>
    fixture(async (path) => {
      const { revision } = await readPromptSource(path);
      const outcomes = await Promise.allSettled([
        updatePromptSource(path, revision, ["active"], patch),
        updatePromptSource(path, revision, ["active"], patch),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    }));
  test("resolver cannot see independent examples; lock reuse makes zero calls", () =>
    fixture(async (path) => {
      let calls = 0;
      const result = await resolvePromptSource(path, async (input) => {
        calls++;
        expect("examples" in input).toBe(false);
        return reply;
      });
      expect(result.reused).toBe(false);
      const before = await readFile(`${path}.lock.json`, "utf8");
      const reused = await resolvePromptSource(path, async () => {
        throw new Error("must not call");
      });
      expect(reused.reused).toBe(true);
      expect(reused.apiCalls).toBe(0);
      expect(calls).toBe(1);
      expect(await readFile(`${path}.lock.json`, "utf8")).toBe(before);
    }));
  test("source changes invalidate Lock and unresolved preserves the prior Lock", () =>
    fixture(async (path) => {
      await resolvePromptSource(path, resolver);
      const before = await readFile(`${path}.lock.json`, "utf8");
      const { revision } = await readPromptSource(path);
      await updatePromptSource(path, revision, ["active"], patch);
      await expect(readPromptResolution(path)).rejects.toThrow(
        "source changed",
      );
      await expect(
        resolvePromptSource(path, async () => ({
          ...reply,
          result: {
            outcome: "unresolved",
            body: null,
            diagnostics: ["ambiguous requirement"],
          },
        })),
      ).rejects.toThrow("ambiguous");
      expect(await readFile(`${path}.lock.json`, "utf8")).toBe(before);
      await resolvePromptSource(path, resolver);
      expect((await readPromptResolution(path)).lock.sourceHash).not.toBe(
        JSON.parse(before).sourceHash,
      );
    }));
  test("well-formed but incorrect IR cannot be published", () =>
    fixture(async (path) => {
      await expect(
        resolvePromptSource(path, async () => ({
          ...reply,
          result: {
            outcome: "resolved",
            body: { kind: "equals", property: ["status"], value: "active" },
            diagnostics: [],
          },
        })),
      ).rejects.toThrow("independent examples");
      await expect(readFile(`${path}.lock.json`)).rejects.toThrow();
    }));
  test("source edit during resolution prevents Lock publication", () =>
    fixture(async (path) => {
      await expect(
        resolvePromptSource(path, async () => {
          const { revision } = await readPromptSource(path);
          await updatePromptSource(path, revision, ["active"], patch);
          return reply;
        }),
      ).rejects.toThrow("changed during resolution");
      await expect(readFile(`${path}.lock.json`)).rejects.toThrow();
    }));
  test("simultaneous resolutions cannot overwrite a winner", () =>
    fixture(async (path) => {
      let release: () => void = () => {};
      const barrier = new Promise<void>((r) => {
        release = r;
      });
      let entered: () => void = () => {};
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const slow = resolvePromptSource(path, async () => {
        entered();
        await barrier;
        return { ...reply, responseId: "slow" };
      });
      await started;
      await resolvePromptSource(path, resolver);
      release();
      await expect(slow).rejects.toThrow("changed during resolution");
      expect((await readPromptResolution(path)).lock.resolver.responseId).toBe(
        "fixture",
      );
    }));
  test("tampering with any lock hash, protocol or source is rejected", () =>
    fixture(async (path) => {
      const { lock } = await resolvePromptSource(path, resolver);
      const { source } = await readPromptSource(path);
      for (const field of ["sourceHash", "irHash", "checksum", "protocol"])
        expect(() =>
          parseResolutionLock({ ...lock, [field]: "tampered" }, source),
        ).toThrow();
      await writeFile(
        `${path}.lock.json`,
        JSON.stringify({ ...lock, checksum: "tampered" }),
      );
      await expect(resolvePromptSource(path, resolver)).rejects.toThrow(
        "checksum",
      );
    }));
  test(
    "build/test/inspect reproduce binaries and reject stale manifests",
    () =>
      fixture(async (path, root) => {
        await resolvePromptSource(path, resolver);
        const first = await buildPromptWasm(path, resolve(root, "a"));
        const second = await buildPromptWasm(path, resolve(root, "b"));
        expect(first.wasmHash).toBe(second.wasmHash);
        expect(await readFile(first.manifest, "utf8")).toBe(
          await readFile(second.manifest, "utf8"),
        );
        expect((await testPromptWasm(path, first.manifest)).passed).toBe(6);
        expect((await inspectPrompt(path, first.manifest)).apiCalls).toBe(0);
        const { revision } = await readPromptSource(path);
        await updatePromptSource(path, revision, ["active"], patch);
        await resolvePromptSource(path, resolver);
        await expect(inspectPrompt(path, first.manifest)).rejects.toThrow(
          "not linked",
        );
      }),
    15000,
  );
  test("CLI draft/update/resolve workflow and invalid options", () =>
    fixture(async (path, root) => {
      const draft = resolve(root, "draft.json");
      await runPromptCli([
        "draft",
        draft,
        "--request",
        resolve(example, "request.txt"),
        "--contract",
        resolve(example, "contract.json"),
        "--examples",
        resolve(example, "examples.json"),
        "--id",
        "active-customer",
        "--fixture",
        resolve(example, "meaning.fixture.json"),
      ]);
      const { revision } = await readPromptSource(draft);
      await runPromptCli([
        "update",
        draft,
        "--revision",
        revision,
        "--ids",
        "active",
        "--request",
        resolve(example, "update.txt"),
        "--fixture",
        resolve(example, "patch.fixture.json"),
      ]);
      await runPromptCli([
        "resolve",
        draft,
        "--fixture",
        resolve(example, "resolution.fixture.json"),
      ]);
      expect(await runPromptCli(["resolve", draft])).toMatchObject({
        reused: true,
        apiCalls: 0,
      });
      await expect(
        runPromptCli(["check", path, "--unknown", "yes"]),
      ).rejects.toThrow();
      await expect(runPromptCli(["build", path])).rejects.toThrow("out-dir");
    }));
});
describe("Prompt model boundary", () => {
  const connection = resolveOpenAIConnection({
    apiKey: "test-only",
    baseUrl: "https://api.openai.com/v1",
  });
  test("Responses adapter uses strict schema, explicit token cap, no retries", async () => {
    let calls = 0;
    const agent = makeOpenAIAgent(
      "explicit-model",
      2048,
      connection,
      async (request) => {
        calls++;
        expect(request).toMatchObject({
          model: "explicit-model",
          store: false,
          max_output_tokens: 2048,
          text: { format: { type: "json_schema", strict: true } },
        });
        expect(JSON.stringify(request)).not.toContain('"examples"');
        return {
          responseId: "test",
          model: "explicit-model",
          outputText: JSON.stringify(resolution),
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        };
      },
    );
    const { examples: _examples, ...source } = parsePromptSource(candidate);
    const result = await makePromptResolver(agent)(source);
    expect(result.usage?.totalTokens).toBe(150);
    expect(calls).toBe(1);
    expect(() => makeOpenAIAgent("x", 0, connection)).toThrow();
    const missingUsage = makeOpenAIAgent("x", 1024, connection, async () => ({
      responseId: "test",
      model: "x",
      outputText: JSON.stringify(resolution),
      usage: null,
    }));
    await expect(makePromptResolver(missingUsage)(source)).rejects.toThrow(
      "missing token usage",
    );
    const failure = makeOpenAIAgent("x", 1024, connection, async () => {
      calls++;
      throw new Error("refused/incomplete");
    });
    await expect(makePromptResolver(failure)(source)).rejects.toThrow(
      "refused",
    );
    expect(calls).toBe(2);
  });
  test("model cannot mutate external tests or unscoped requirements", async () => {
    const source = parsePromptSource(candidate);
    await expect(
      proposeMeaning(
        async () => ({ ...reply, result: { ...source, examples: [] } }),
        "request",
        source.contract,
      ),
    ).rejects.toThrow();
    await expect(
      proposePatch(
        async () => ({ ...reply, result: patch }),
        source,
        "request",
        ["has-email"],
      ),
    ).rejects.toThrow("authorized");
  });
});

test(
  "TS-free CLI builds in separate processes without loading a model client or TS compiler",
  () =>
    fixture(async (path, root) => {
      await resolvePromptSource(path, resolver);
      const before = await readFile(`${path}.lock.json`, "utf8");
      const runner = resolve(root, "offline.ts");
      const modulePath = resolve(import.meta.dir, "prompt-cli.ts").replaceAll(
        "\\",
        "/",
      );
      await writeFile(
        runner,
        `import { plugin } from "bun";
plugin({ name: "forbid-legacy", setup(b) { b.onResolve({ filter: /typescript|openai|semantic-source|semantic-resolution-reader|generator/ }, () => { throw new Error("forbidden dependency in offline build"); }); } });
const { runPromptCli } = await import(${JSON.stringify(modulePath)});
console.log(JSON.stringify(await runPromptCli(process.argv.slice(2))));`,
      );
      async function child(args: string[]) {
        const p = Bun.spawn([process.execPath, runner, ...args], {
          cwd: root,
          env: { ...process.env, OPENAI_API_KEY: "", AZURE_OPENAI_API_KEY: "" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        return JSON.parse(stdout);
      }
      const a = await child(["build", path, "--out-dir", resolve(root, "one")]);
      const b = await child(["build", path, "--out-dir", resolve(root, "two")]);
      expect(a.wasmHash).toBe(b.wasmHash);
      expect(await readFile(a.manifest, "utf8")).toBe(
        await readFile(b.manifest, "utf8"),
      );
      expect(
        (await child(["test", path, "--manifest", a.manifest])).passed,
      ).toBe(6);
      expect(
        (await child(["inspect", path, "--manifest", a.manifest])).apiCalls,
      ).toBe(0);
      expect((await child(["resolve", path])).reused).toBe(true);
      expect(await readFile(`${path}.lock.json`, "utf8")).toBe(before);
    }),
  30000,
);

test("null and invalid stale Locks are corruption, never cache misses", () =>
  fixture(async (path) => {
    await writeFile(`${path}.lock.json`, "null\n");
    let calls = 0;
    const mustNotCall: PromptResolver = async () => {
      calls++;
      return reply;
    };
    await expect(resolvePromptSource(path, mustNotCall)).rejects.toThrow();
    expect(await readFile(`${path}.lock.json`, "utf8")).toBe("null\n");
    await rm(`${path}.lock.json`);
    const { lock } = await resolvePromptSource(path, resolver);
    const { revision } = await readPromptSource(path);
    await updatePromptSource(path, revision, ["active"], patch);
    const { checksum: _checksum, ...unsigned } = lock;
    for (const change of [
      { protocol: "unknown-version" },
      { irHash: "a".repeat(64) },
      {
        resolver: {
          ...lock.resolver,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 3 },
        },
      },
    ]) {
      const broken = { ...unsigned, ...change };
      const text = JSON.stringify({ ...broken, checksum: contentHash(broken) });
      await writeFile(`${path}.lock.json`, text);
      await expect(resolvePromptSource(path, mustNotCall)).rejects.toThrow();
      expect(await readFile(`${path}.lock.json`, "utf8")).toBe(text);
    }
    expect(calls).toBe(0);
  }));

test("runtime refuses a manifest replaced after source linkage validation", () =>
  fixture(async (path, root) => {
    await resolvePromptSource(path, resolver);
    const output = await buildPromptWasm(path, resolve(root, "build"));
    const { readArtifact } = await import("./wasm-artifact");
    const { digest } = await import("./wasm-contract");
    const { loadWasmPredicate } = await import("./wasm-runtime");
    const validated = (await readArtifact(output.manifest)).manifest;
    const expectedHash = digest(JSON.stringify(validated));
    await writeFile(
      output.manifest,
      JSON.stringify({ ...validated, compiler: "different-build" }),
    );
    await expect(
      loadWasmPredicate(output.manifest, expectedHash),
    ).rejects.toThrow("changed after validation");
    // A stable snapshot still loads normally, and the old runtime API remains usable.
    await writeFile(output.manifest, JSON.stringify(validated));
    expect(
      (await loadWasmPredicate(output.manifest, expectedHash)).evaluate({
        status: "active",
        deletedAt: null,
        email: "",
      }),
    ).toBe(true);
    expect((await testPromptWasm(path, output.manifest)).revision).toBe(
      (await readPromptSource(path)).revision,
    );
  }));
