import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { compileSemanticSource, type SemanticResolution } from "./semantic-compiler";
import { detectSemanticSourceKind } from "./semantic-source-kind";
import { renderSemanticDiff } from "./semantic-diff";
import {
  approveSemanticEvolution,
  checkSemanticEvolution,
  readSemanticEvolutionCandidate,
} from "./semantic-evolution";
import {
  callOpenAI,
  DEFAULT_OPENAI_MODEL,
  parseElaborationResult,
  parseOpenAIResponse,
  resolveOpenAIConnection,
} from "./openai";
import {
  compileStaticJudgmentSource,
  type StaticJudgmentCompilerResolution,
} from "./static-judgment-compiler";
import {
  callStaticJudgmentOpenAI,
  parseStaticJudgmentResolution,
} from "./static-judgment";

async function main(): Promise<void> {
  const [command, target, ...options] = Bun.argv.slice(2);
  if (
    !["build", "replay", "test", "check", "diff", "approve"].includes(
      command ?? "",
    ) ||
    target === undefined
  ) {
    throw new Error(
      [
        "Usage:",
        "  bun run semantic <build|replay|test> <semantic-source.ts> [--fixture <response.json>]",
        "  bun run semantic check <semantic-source.ts> [--fixture <response.json>] [--samples 3 --quorum 2]",
        "  bun run semantic diff <candidate-id>",
        "  bun run semantic approve <candidate-id>",
      ].join("\n"),
    );
  }

  const fixturePath = readOption(options, "--fixture");
  if (command !== "build" && command !== "check" && fixturePath !== undefined) {
    throw new Error(`${command} does not accept --fixture and never calls an API`);
  }

  if (command === "diff") {
    const { candidate, candidateDirectory } =
      await readSemanticEvolutionCandidate(target);
    console.log(renderSemanticDiff(candidate.diff));
    console.log(`candidate: ${candidate.id}`);
    console.log(`status: ${candidate.status}`);
    console.log(`audit: ${candidateDirectory}`);
    return;
  }

  if (command === "approve") {
    const result = await approveSemanticEvolution(target);
    console.log(
      [
        "semantic evolution approved",
        `candidate: ${result.candidate.id}`,
        `classification: ${result.candidate.diff.classification}`,
        `output: ${result.output}`,
        `fingerprint: ${result.candidate.proposedFingerprint}`,
      ].join("\n"),
    );
    return;
  }

  const resolvedTarget = resolve(target);
  const sourceKind = await detectSemanticSourceKind(resolvedTarget);
  if (sourceKind === "static-judgment") {
    if (command !== "build" && command !== "replay") {
      throw new Error(
        `semantic ${command} does not support Static Judgment sources; use build or replay`,
      );
    }

    let provider: string | undefined;
    let model: string | undefined;
    let countsAsApiCall: boolean | undefined;
    let resolver: Parameters<typeof compileStaticJudgmentSource>[0]["resolve"];

    if (command === "build" && fixturePath !== undefined) {
      const absoluteFixture = resolve(fixturePath);
      const fixturePayload = JSON.parse(
        await readFile(absoluteFixture, "utf8"),
      ) as unknown;
      const fixtureResponse = parseOpenAIResponse(fixturePayload);
      provider = `fixture:${basename(absoluteFixture)}`;
      model = fixtureResponse.model;
      countsAsApiCall = false;
      resolver = async (): Promise<StaticJudgmentCompilerResolution> => ({
        judgment: parseStaticJudgmentResolution(
          JSON.parse(fixtureResponse.outputText) as unknown,
        ),
        response: fixtureResponse,
        rawOutput: fixturePayload,
      });
    } else if (command === "build") {
      model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
      const connection = resolveOpenAIConnection({
        apiKey: process.env.OPENAI_API_KEY ?? "",
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      });
      provider = connection.provider;
      resolver = async (input): Promise<StaticJudgmentCompilerResolution> => {
        if (connection.apiKey.length === 0) {
          throw new Error(
            "OPENAI_API_KEY is required on a Static Judgment lock miss",
          );
        }
        const response = await callStaticJudgmentOpenAI(
          { model: model!, ...input },
          connection,
        );
        return {
          judgment: parseStaticJudgmentResolution(
            JSON.parse(response.outputText) as unknown,
          ),
          response,
          rawOutput: JSON.parse(response.outputText) as unknown,
        };
      };
    }

    const result = await compileStaticJudgmentSource({
      sourcePath: resolvedTarget,
      mode: command,
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(countsAsApiCall === undefined ? {} : { countsAsApiCall }),
      ...(resolver === undefined ? {} : { resolve: resolver }),
    });
    console.log(
      [
        `Static Judgment ${command} passed`,
        `judgment: ${result.resolvedValue}`,
        `output: ${result.output}`,
        `provider/model: ${result.provider}/${result.model}`,
        `api calls: ${result.apiCalls}`,
        `cache hit: ${result.cacheHit}`,
        `sha256: ${result.generatedCodeHash}`,
        `report: ${result.report}`,
      ].join("\n"),
    );
    return;
  }

  let provider: string | undefined;
  let model: string | undefined;
  let countsAsApiCall: boolean | undefined;
  let resolver: Parameters<typeof compileSemanticSource>[0]["resolve"];

  if ((command === "build" || command === "check") && fixturePath !== undefined) {
    const absoluteFixture = resolve(fixturePath);
    const fixturePayload = JSON.parse(await readFile(absoluteFixture, "utf8")) as unknown;
    const fixtureResponse = parseOpenAIResponse(fixturePayload);
    provider = `fixture:${basename(absoluteFixture)}`;
    model = fixtureResponse.model;
    countsAsApiCall = false;
    resolver = async (): Promise<SemanticResolution> => ({
      elaboration: parseElaborationResult(
        JSON.parse(fixtureResponse.outputText) as unknown,
      ),
      response: fixtureResponse,
      rawOutput: fixturePayload,
    });
  } else if (command === "build" || command === "check") {
    model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    const connection = resolveOpenAIConnection({
      apiKey: process.env.OPENAI_API_KEY ?? "",
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    });
    provider = connection.provider;
    resolver = async (input): Promise<SemanticResolution> => {
      if (connection.apiKey.length === 0) {
        throw new Error("OPENAI_API_KEY is required on a semantic lock miss");
      }
      const response = await callOpenAI(
        {
          model: model!,
          specification: input.specification,
          typeScriptSource: input.typeScriptSource,
          target: {
            functionName: input.functionName,
            parameterName: input.parameterName,
            typeName: input.typeName,
          },
        },
        connection,
      );
      return {
        elaboration: parseElaborationResult(JSON.parse(response.outputText) as unknown),
        response,
        rawOutput: JSON.parse(response.outputText) as unknown,
      };
    };
  }

  if (command === "check") {
    const samples = readIntegerOption(options, "--samples", 3);
    const quorum = readIntegerOption(options, "--quorum", samples === 1 ? 1 : 2);
    const result = await checkSemanticEvolution({
      sourcePath: resolve(target),
      provider: provider!,
      model: model!,
      ...(countsAsApiCall === undefined ? {} : { countsAsApiCall }),
      samples,
      quorum,
      resolve: resolver!,
    });
    if (result.status === "up-to-date") {
      console.log(
        [
          "semantic check: up-to-date",
          `source: ${result.source}`,
          `fingerprint: ${result.fingerprint}`,
          "api calls: 0",
        ].join("\n"),
      );
      return;
    }
    console.log(renderSemanticDiff(result.candidate.diff));
    console.log(
      [
        `candidate: ${result.candidate.id}`,
        `status: ${result.candidate.status}`,
        `api calls: ${result.apiCalls}`,
        `consensus: ${result.candidate.consensus === null
          ? "disabled"
          : `${result.candidate.consensus.supportingSamples.length}/${result.candidate.consensus.samples} (${result.candidate.consensus.reached ? "reached" : "unresolved"})`}`,
        `audit: ${result.candidateDirectory}`,
        result.candidate.status === "ready"
          ? `approve: bun run semantic approve ${result.candidate.id}`
          : "approve: unavailable",
      ].join("\n"),
    );
    return;
  }

  const result = await compileSemanticSource({
    sourcePath: resolvedTarget,
    mode: command === "build" ? "build" : "replay",
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(countsAsApiCall === undefined ? {} : { countsAsApiCall }),
    ...(resolver === undefined ? {} : { resolve: resolver }),
  });

  console.log(
    [
      `semantic ${command} passed`,
      `output: ${result.output}`,
      `provider/model: ${result.provider}/${result.model}`,
      `api calls: ${result.apiCalls}`,
      `cache hit: ${result.cacheHit}`,
      `sha256: ${result.generatedCodeHash}`,
      `report: ${result.report}`,
    ].join("\n"),
  );
}

function readOption(options: string[], name: string): string | undefined {
  const index = options.indexOf(name);
  if (index === -1) return undefined;
  const value = options[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}

function readIntegerOption(options: string[], name: string, fallback: number): number {
  const value = readOption(options, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} requires an integer`);
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
