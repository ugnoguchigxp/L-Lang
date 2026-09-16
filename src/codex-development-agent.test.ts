import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import type { RunResult, ThreadOptions } from "@openai/codex-sdk";
import {
  makeCodexDevelopmentAgent,
  CODEX_MODEL,
} from "./codex-development-agent";
import {
  fixtureConfig,
  parseDevelopmentConfig,
} from "./capability-development";
import { runDevelopmentCli } from "./capability-development-cli";

const request = {
  stage: "implementation" as const,
  instruction: "Generate",
  input: { value: true },
  schema: { type: "object" },
};
const turn: RunResult = {
  finalResponse: '{"ok":true}',
  items: [],
  usage: {
    input_tokens: 100,
    output_tokens: 10,
    cached_input_tokens: 20,
    cache_write_input_tokens: 0,
    reasoning_output_tokens: 2,
  },
};
test("Codex uses Terra medium, fresh read-only sessions, schema, abort signal, and normalized usage", async () => {
  const options: ThreadOptions[] = [];
  const controller = new AbortController();
  const agent = makeCodexDevelopmentAgent((config) => {
    expect(config.configOverrides).toContain("mcp_servers={}");
    return {
      startThread: (o) => {
        options.push(o);
        return {
          id: `thread-${options.length}`,
          run: async (prompt, opts) => {
            expect(prompt).toContain(JSON.stringify(request.input));
            expect(opts.outputSchema).toEqual(request.schema);
            expect(opts.signal).toBe(controller.signal);
            return turn;
          },
        };
      },
    };
  });
  const reply = await agent(request, controller.signal);
  await agent(request, controller.signal);
  expect(reply.model).toBe(CODEX_MODEL);
  expect(reply.provider).toBe("codex-sdk/medium");
  expect(reply.usage).toEqual({
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
  });
  expect(options[0]).toMatchObject({
    model: CODEX_MODEL,
    modelReasoningEffort: "medium",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    webSearchMode: "disabled",
  });
  expect(options[0]?.workingDirectory).not.toBe(options[1]?.workingDirectory);
  for (const o of options)
    await expect(access(o.workingDirectory as string)).rejects.toThrow();
});
test.each([
  "bad-json",
  "too-large",
  "tool",
  "missing-id",
  "bad-usage",
  "failure",
])("Codex rejects %s and cleans temporary workspaces", async (kind) => {
  let directory = "";
  const agent = makeCodexDevelopmentAgent(() => ({
    startThread: (o) => {
      directory = o.workingDirectory as string;
      return {
        id: kind === "missing-id" ? null : "id",
        run: async () => {
          if (kind === "failure") throw new Error("failed");
          return {
            ...turn,
            finalResponse:
              kind === "bad-json"
                ? "not json"
                : kind === "too-large"
                  ? "x".repeat(50000)
                  : turn.finalResponse,
            items:
              kind === "tool"
                ? [{ type: "web_search", id: "x", query: "x" }]
                : [],
            usage:
              kind === "bad-usage"
                ? {
                    ...(turn.usage as NonNullable<RunResult["usage"]>),
                    input_tokens: -1,
                  }
                : turn.usage,
          };
        },
      };
    },
  }));
  await expect(agent(request)).rejects.toThrow();
  await expect(access(directory)).rejects.toThrow();
});
test("Codex missing usage remains unknown and pre-aborted calls do not start a session", async () => {
  const agent = makeCodexDevelopmentAgent(() => ({
    startThread: () => ({
      id: "id",
      run: async () => ({ ...turn, usage: null }),
    }),
  }));
  expect((await agent(request)).usage).toBeNull();
  await expect(agent(request, AbortSignal.abort())).rejects.toThrow();
});
test("Codex config is opt-in, model is fixed, CLI rejects provider/fixture mixing", async () => {
  expect(
    parseDevelopmentConfig({
      ...fixtureConfig,
      agent: "codex-sdk",
      model: CODEX_MODEL,
    }).agent,
  ).toBe("codex-sdk");
  expect(() =>
    parseDevelopmentConfig({ ...fixtureConfig, agent: "codex-sdk" }),
  ).toThrow();
  await expect(
    runDevelopmentCli([
      "develop",
      "examples/capability-development/access/source.json",
      "--metadata",
      "examples/capability-development/access/metadata.json",
      "--out-dir",
      "unused",
      "--fixtures",
      "unused",
      "--agent",
      "codex-sdk",
    ]),
  ).rejects.toThrow("cannot be combined");
});
