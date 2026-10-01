import { Codex } from "@openai/codex-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexFactory } from "./codex-development-agent";
import { buildOpenAIRequest, predicateElaborationJsonSchema } from "./openai";
import type { collectBestOfNCandidates } from "./semantic-tdd-best-of-n";

/** Each draw uses a fresh, tool-free SDK thread and the same frozen request. */
export function makeCodexTddResolver(
  model: string,
  factory: CodexFactory = (options) => new Codex(options),
): Parameters<typeof collectBestOfNCandidates>[0]["resolve"] {
  if (!["gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-sol"].includes(model))
    throw new Error(
      "Codex TDD evaluation requires a supported evaluation model",
    );
  return async (request, limits) => {
    limits.signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(limits.signal.reason);
    limits.signal.addEventListener("abort", abort, { once: true });
    const directory = await mkdtemp(join(tmpdir(), "llang-tdd-codex-"));
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            ![
              "OPENAI_API_KEY",
              "OPENAI_BASE_URL",
              "AZURE_OPENAI_API_KEY",
            ].includes(entry[0]),
        ),
      );
      const client = factory({
        env,
        configOverrides: ["mcp_servers={}", "plugins={}"],
        config: {
          features: {
            shell_tool: false,
            unified_exec: false,
            multi_agent: false,
            apps: false,
            image_generation: false,
          },
          project_doc_max_bytes: 0,
        },
      });
      const thread = client.startThread({
        model,
        modelReasoningEffort: "low",
        workingDirectory: directory,
        skipGitRepoCheck: true,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      });
      const prompt = buildOpenAIRequest({
        model,
        specification: request.specification,
        typeScriptSource: request.typeScriptSource,
        target: {
          functionName: request.functionName,
          parameterName: request.parameterName,
          typeName: request.typeName,
        },
        ...(request.projectContext === undefined
          ? {}
          : { projectContext: request.projectContext }),
      }) as { instructions: string; input: string };
      const turn = await thread.run(
        `${prompt.instructions}\nUse only the supplied data. Do not use tools or inspect files. Return only the requested JSON.\n${prompt.input}`,
        {
          outputSchema: predicateElaborationJsonSchema,
          signal: controller.signal,
        },
      );
      if (
        !thread.id ||
        turn.items.some(
          (item) => !["agent_message", "reasoning"].includes(item.type),
        )
      )
        throw new Error(
          "Codex returned missing identity, a tool call or an error",
        );
      // The SDK lacks a per-turn server output cap. The collector enforces observed token limits after receipt.
      let output: unknown;
      try {
        output = JSON.parse(turn.finalResponse);
      } catch {
        output = turn.finalResponse;
      }
      return {
        elaboration: output,
        rawOutput: output,
        response: {
          responseId: thread.id,
          model,
          outputText: turn.finalResponse,
          usage:
            turn.usage === null
              ? null
              : {
                  inputTokens: turn.usage.input_tokens,
                  outputTokens: turn.usage.output_tokens,
                  totalTokens:
                    turn.usage.input_tokens + turn.usage.output_tokens,
                },
        },
      };
    } finally {
      limits.signal.removeEventListener("abort", abort);
      await rm(directory, { recursive: true, force: true });
    }
  };
}
