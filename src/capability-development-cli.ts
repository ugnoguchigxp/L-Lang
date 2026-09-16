import {
  developCapability,
  fixtureConfig,
  fixtureDevelopmentAgent,
  parseDevelopmentConfig,
  replayDevelopment,
} from "./capability-development";
import { checkCapabilityMutations } from "./capability-mutation";
import { writeCapabilityJsonReport } from "./capability-package";
import type { DevelopmentAgent } from "./capability-test-agent";
import { invalid } from "./capability-tests";
import { readJson } from "./prompt-source";

export async function runDevelopmentCli(args: string[]) {
  const [command, path, ...rest] = args;
  if (!path) invalid("missing path");
  const allowed =
    command === "develop"
      ? [
          "--metadata",
          "--fixtures",
          "--out-dir",
          "--model",
          "--agent",
          "--max-output-tokens",
          "--max-total-tokens",
          "--max-wall-ms",
          "--max-calls",
        ]
      : command === "mutation-check"
        ? ["--report"]
        : ["--out-dir"];
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (
      !key ||
      !allowed.includes(key) ||
      Object.hasOwn(options, key) ||
      !value ||
      value.startsWith("--")
    )
      invalid("invalid development CLI options");
    options[key] = value;
  }
  const required = (key: string) => options[key] ?? invalid(`missing ${key}`);
  if (command === "mutation-check") {
    const report = required("--report");
    const result = await checkCapabilityMutations(path);
    await writeCapabilityJsonReport(report, result, path);
    return {
      exitCode:
        (result.counts.error ?? 0) ||
        (result.counts.unknown ?? 0) ||
        result.omittedProposals > 0
          ? 2
          : (result.counts.survived ?? 0)
            ? 1
            : 0,
      result,
    };
  }
  if (command === "replay-development") {
    const result = await replayDevelopment(path, required("--out-dir"));
    return {
      exitCode: result.status === "pass" ? 0 : result.status === "fail" ? 1 : 2,
      result,
    };
  }
  if (command !== "develop") invalid("unknown development command");
  const source = await readJson(path),
    metadata = await readJson(required("--metadata")),
    output = required("--out-dir");
  let agent: DevelopmentAgent,
    config = fixtureConfig;
  if (options["--fixtures"]) {
    if (
      Object.keys(options).some(
        (k) => k === "--model" || k === "--agent" || k.startsWith("--max-"),
      )
    )
      invalid("fixture and live settings cannot be combined");
    agent = fixtureDevelopmentAgent(await readJson(options["--fixtures"]));
  } else {
    const codex = options["--agent"] === "codex-sdk";
    if (options["--agent"] && !codex) invalid("unknown development agent");
    config = parseDevelopmentConfig({
      version: 1,
      mode: "live",
      model: codex
        ? (options["--model"] ?? "gpt-5.6-terra")
        : required("--model"),
      ...(codex ? { agent: "codex-sdk" } : {}),
      maxCalls: Number(options["--max-calls"] ?? 3),
      maxOutputTokens: Number(required("--max-output-tokens")),
      maxTotalTokens: Number(required("--max-total-tokens")),
      maxWallMs: Number(required("--max-wall-ms")),
    });
    if (codex) {
      const { makeCodexDevelopmentAgent } = await import(
        "./codex-development-agent"
      );
      agent = makeCodexDevelopmentAgent();
    } else {
      const key =
        process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_API_KEY;
      if (!key) invalid("API credentials are required for live development");
      const { makeOpenAIAgent } = await import("./prompt-agent");
      const { resolveOpenAIConnection, callResponsesApi } = await import(
        "./openai"
      );
      const connection = resolveOpenAIConnection({
        apiKey: key,
        baseUrl:
          process.env.OPENAI_BASE_URL ||
          process.env.AZURE_OPENAI_BASE_URL ||
          "https://api.openai.com/v1",
      });
      agent = async (request, signal) =>
        makeOpenAIAgent(
          config.model,
          config.maxOutputTokens,
          connection,
          (body, conn) => callResponsesApi(body, conn, signal),
        )(request.instruction, request.input, request.schema);
    }
  }
  const result = await developCapability(
    source,
    metadata,
    config,
    agent,
    output,
  );
  return {
    exitCode: result.status === "pass" ? 0 : result.status === "fail" ? 1 : 2,
    result,
  };
}
