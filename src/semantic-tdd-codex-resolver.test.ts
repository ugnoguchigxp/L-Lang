import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { makeCodexTddResolver } from "./semantic-tdd-codex-resolver";
import type { ThreadOptions } from "@openai/codex-sdk";
const request = {
  specification: "frozen-plan",
  typeScriptSource: "type T={ok:boolean}",
  functionName: "isT",
  parameterName: "t",
  typeName: "T",
};
test.each(["gpt-6-luna", "gpt-6.1-sol"])(
  "SDK %s low draws use isolated threads, no API-key environment, identical data, schema and usage",
  async (model) => {
    const starts: ThreadOptions[] = [],
      prompts: string[] = [];
    const signal = new AbortController().signal;
    const resolver = makeCodexTddResolver(model, (options) => {
      expect(options.env?.OPENAI_API_KEY).toBeUndefined();
      expect(options.env?.OPENAI_BASE_URL).toBeUndefined();
      expect(options.configOverrides).toEqual(["mcp_servers={}", "plugins={}"]);
      expect(options.config?.features).toMatchObject({
        apps: false,
        shell_tool: false,
        multi_agent: false,
      });
      return {
        startThread: (opts) => {
          starts.push(opts);
          return {
            id: "thread-id",
            run: async (input, opts) => {
              prompts.push(input);
              expect(opts.signal?.aborted).toBe(false);
              expect(opts.outputSchema).toBeDefined();
              return {
                finalResponse:
                  '{"outcome":"unresolved","body":null,"diagnostics":[]}',
                items: [],
                usage: {
                  input_tokens: 10,
                  output_tokens: 5,
                  cached_input_tokens: 0,
                  cache_write_input_tokens: 0,
                  reasoning_output_tokens: 1,
                },
              };
            },
          };
        },
      };
    });
    const reply = await resolver(request, { signal, maxOutputTokens: 100 });
    await resolver(request, { signal, maxOutputTokens: 100 });
    expect(prompts[0]).toBe(prompts[1]);
    expect(starts[0]).toMatchObject({
      model,
      modelReasoningEffort: "low",
      approvalPolicy: "never",
      sandboxMode: "read-only",
      networkAccessEnabled: false,
    });
    expect(starts[0]?.workingDirectory).not.toBe(starts[1]?.workingDirectory);
    for (const opts of starts)
      await expect(access(opts.workingDirectory as string)).rejects.toThrow();
    expect(reply.response?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  },
);
test("SDK refuses alternate models and aborts before creating a client", async () => {
  expect(() => makeCodexTddResolver("other")).toThrow();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const resolver = makeCodexTddResolver("gpt-6-luna", () => {
    called = true;
    throw new Error("unexpected");
  });
  await expect(
    resolver(request, { signal: controller.signal, maxOutputTokens: 100 }),
  ).rejects.toThrow();
  expect(called).toBe(false);
});

test("finishing a draw detaches SDK cancellation before collector cleanup", async () => {
  const controller = new AbortController();
  let sdkSignal: AbortSignal | undefined;
  const resolver = makeCodexTddResolver("gpt-5.6-luna", () => ({
    startThread: () => ({
      id: "id",
      run: async (_input, options) => {
        sdkSignal = options.signal;
        return { items: [], usage: null, finalResponse: "invalid-json" };
      },
    }),
  }));
  const reply = await resolver(request, {
    signal: controller.signal,
    maxOutputTokens: 100,
  });
  controller.abort();
  expect(sdkSignal?.aborted).toBe(false);
  expect(reply.response?.usage).toBeNull();
  expect(reply.rawOutput).toBe("invalid-json");
});

test("SDK tool use is rejected and its temporary directory is removed", async () => {
  let directory = "";
  const resolver = makeCodexTddResolver("gpt-5.6-luna", () => ({
    startThread: (options) => {
      directory = options.workingDirectory as string;
      return {
        id: "id",
        run: async () => ({
          finalResponse: "{}",
          usage: null,
          items: [{ type: "web_search", id: "tool", query: "unexpected" }],
        }),
      };
    },
  }));
  await expect(
    resolver(request, {
      signal: new AbortController().signal,
      maxOutputTokens: 100,
    }),
  ).rejects.toThrow("tool call");
  await expect(access(directory)).rejects.toThrow();
});
