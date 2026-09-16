import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
  type TurnOptions,
  type RunResult,
} from "@openai/codex-sdk";
import type { DevelopmentAgent } from "./capability-test-agent";
import { parseAgentReply } from "./capability-test-agent";

export const CODEX_MODEL = "gpt-5.6-terra";
export const CODEX_REASONING = "medium";
export type CodexClient = {
  startThread(options: ThreadOptions): {
    readonly id: string | null;
    run(input: string, options: TurnOptions): Promise<RunResult>;
  };
};
export type CodexFactory = (options: CodexOptions) => CodexClient;

export function makeCodexDevelopmentAgent(
  factory: CodexFactory = (options) => new Codex(options),
): DevelopmentAgent {
  return async (request, signal) => {
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "llang-codex-"));
    try {
      const codex = factory({
        // Do not load project-local instructions or expose the implementation to test generation.
        configOverrides: ["mcp_servers={}", "plugins={}"],
        config: {
          features: {
            shell_tool: false,
            unified_exec: false,
            multi_agent: false,
            apps: false,
          },
          project_doc_max_bytes: 0,
        },
      });
      const thread = codex.startThread({
        model: CODEX_MODEL,
        modelReasoningEffort: CODEX_REASONING,
        workingDirectory: directory,
        skipGitRepoCheck: true,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      });
      const turn = await thread.run(
        `${request.instruction}\nUse only the supplied data. Do not use tools, inspect files, or change files. Return only the requested JSON.\n${JSON.stringify(request.input)}`,
        { outputSchema: request.schema, ...(signal ? { signal } : {}) },
      );
      if (
        turn.items.some(
          (item) => !["agent_message", "reasoning"].includes(item.type),
        )
      )
        throw new Error(
          "Codex generation used an unexpected tool or returned an error",
        );
      if (Buffer.byteLength(turn.finalResponse) > 48 * 1024)
        throw new Error("Codex response exceeds 48 KiB");
      if (!thread.id) throw new Error("Codex did not return a thread ID");
      return parseAgentReply({
        result: JSON.parse(turn.finalResponse),
        provider: "codex-sdk/medium",
        model: CODEX_MODEL,
        responseId: thread.id,
        usage: turn.usage
          ? {
              inputTokens: turn.usage.input_tokens,
              outputTokens: turn.usage.output_tokens,
              totalTokens: turn.usage.input_tokens + turn.usage.output_tokens,
            }
          : null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
