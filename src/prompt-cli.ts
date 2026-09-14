import { readFile } from "node:fs/promises";
import type { StructuredAgent } from "./prompt-agent";
import { resolvePromptSource } from "./prompt-resolution";
import {
  createPromptSource,
  fail,
  parsePromptSource,
  readJson,
  readPromptSource,
  updatePromptSource,
} from "./prompt-source";
import { buildPromptWasm, inspectPrompt, testPromptWasm } from "./prompt-wasm";
import { parseContract } from "./wasm-contract";

function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !key ||
      !allowed.includes(key) ||
      value === undefined ||
      value.startsWith("--") ||
      Object.hasOwn(result, key)
    )
      fail("invalid or duplicate CLI option");
    result[key] = value;
  }
  return result;
}
function required(o: Record<string, string>, key: string): string {
  const value = o[key];
  if (!value) fail(`missing ${key}`);
  return value;
}
async function agent(o: Record<string, string>): Promise<StructuredAgent> {
  if (o["--fixture"]) {
    if (o["--model"] || o["--max-output-tokens"])
      fail("fixture and live options are mutually exclusive");
    const path = o["--fixture"];
    return async () => ({
      result: await readJson(path),
      provider: "fixture",
      model: "fixture",
      responseId: "fixture",
      usage: null,
    });
  }
  const { makeOpenAIAgent } = await import("./prompt-agent");
  const { resolveOpenAIConnection } = await import("./openai");
  const model = required(o, "--model");
  const max = Number(required(o, "--max-output-tokens"));
  const apiKey = process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_API_KEY;
  if (!apiKey) fail("OPENAI_API_KEY or AZURE_OPENAI_API_KEY is required");
  const baseUrl =
    process.env.OPENAI_BASE_URL || process.env.AZURE_OPENAI_BASE_URL;
  return makeOpenAIAgent(
    model,
    max,
    resolveOpenAIConnection({
      apiKey,
      baseUrl: baseUrl ?? "https://api.openai.com/v1",
    }),
  );
}
const modelOptions = ["--fixture", "--model", "--max-output-tokens"];
export async function runPromptCli(args: string[]): Promise<unknown> {
  const [command, path, ...rest] = args;
  if (!path)
    fail(
      "usage: prompt <create|draft|update|resolve|check|build|test|inspect> <source.json> [options]",
    );
  if (command === "create") {
    const o = options(rest, ["--from"]);
    return createPromptSource(path, await readJson(required(o, "--from")));
  }
  if (command === "draft") {
    const o = options(rest, [
      "--request",
      "--contract",
      "--examples",
      "--id",
      ...modelOptions,
    ]);
    const contract = parseContract(await readJson(required(o, "--contract")));
    const examples = await readJson(required(o, "--examples"));
    const id = required(o, "--id");
    const request = await readFile(required(o, "--request"), "utf8");
    // Validate user-owned inputs before making any paid call.
    parsePromptSource({
      version: 1,
      kind: "predicate",
      id,
      intent: request,
      requirements: [{ id: "request", level: "must", text: request }],
      unresolvedWhen: [],
      profile: "predicate-i32-v1",
      contract,
      examples,
    });
    const { proposeMeaning } = await import("./prompt-agent");
    const { meaning, audit } = await proposeMeaning(
      await agent(o),
      request,
      contract,
    );
    const result = await createPromptSource(path, {
      version: 1,
      kind: "predicate",
      id,
      ...meaning,
      profile: "predicate-i32-v1",
      contract,
      examples,
    });
    return { ...result, audit };
  }
  if (command === "update") {
    const o = options(rest, [
      "--revision",
      "--ids",
      "--request",
      ...modelOptions,
    ]);
    const revision = required(o, "--revision");
    const { source, revision: current } = await readPromptSource(path);
    if (revision !== current) fail("source revision changed");
    const ids = required(o, "--ids").split(",");
    const request = await readFile(required(o, "--request"), "utf8");
    const { proposePatch } = await import("./prompt-agent");
    const patch = await proposePatch(await agent(o), source, request, ids);
    return updatePromptSource(path, revision, ids, patch);
  }
  if (command === "resolve") {
    const o = options(rest, modelOptions);
    // Construct the live adapter lazily: reusing a valid Lock needs no credentials.
    return resolvePromptSource(path, async (input) => {
      const { makePromptResolver } = await import("./prompt-agent");
      return makePromptResolver(await agent(o))(input);
    });
  }
  if (command === "check") {
    options(rest, []);
    return readPromptSource(path);
  }
  if (command === "build") {
    const o = options(rest, ["--out-dir"]);
    return buildPromptWasm(path, required(o, "--out-dir"));
  }
  if (command === "test") {
    const o = options(rest, ["--manifest"]);
    return testPromptWasm(path, required(o, "--manifest"));
  }
  if (command === "inspect") {
    const o = options(rest, ["--manifest"]);
    return inspectPrompt(path, o["--manifest"]);
  }
  return fail("unknown command");
}
if (import.meta.main) {
  try {
    console.log(
      JSON.stringify(await runPromptCli(process.argv.slice(2)), null, 2),
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
