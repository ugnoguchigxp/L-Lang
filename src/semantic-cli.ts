import { basename, resolve } from "node:path";
import {
  callOpenAI,
  callResponsesApi,
  DEFAULT_OPENAI_MODEL,
  parseElaborationResult,
  parseOpenAIResponse,
  resolveOpenAIConnection,
} from "./openai";
import { parseSemanticArguments, semanticCommands } from "./semantic-arguments";
import { checkSemanticClosure } from "./semantic-closure";
import { renderSemanticClosure } from "./semantic-closure-renderer";
import {
  compileSemanticSource,
  type SemanticResolution,
} from "./semantic-compiler";
import { renderSemanticDiff } from "./semantic-diff";
import {
  normalizeSemanticError,
  renderSemanticError,
  semanticErrorJson,
} from "./semantic-error";
import {
  approveSemanticEvolution,
  checkSemanticEvolution,
  readSemanticEvolutionCandidate,
} from "./semantic-evolution";
import { explainSemanticSource } from "./semantic-explain";
import { renderSemanticExplanation } from "./semantic-explain-renderer";
import { readBoundedJsonFile } from "./semantic-limits";
import {
  approveSemanticReview,
  readSemanticReviewCandidate,
} from "./semantic-review";
import { detectSemanticSourceKind } from "./semantic-source-kind";
import { compileSemanticTddSource } from "./semantic-tdd-compiler";
import { verifySemanticTddSource } from "./semantic-tdd-verify";
import {
  approveSemanticTestReview,
  createSemanticTestReviewCandidate,
  readSemanticTestReviewCandidate,
} from "./semantic-test-review";
import {
  buildSemanticTestSynthesisRequest,
  parseSemanticTestSynthesisResult,
  type SemanticTestSynthesisResolution,
} from "./semantic-test-synthesizer";
import { runSemanticTests } from "./semantic-test-runner";
import { verifySemanticArtifact } from "./semantic-verify";
import { renderSemanticVerify } from "./semantic-verify-renderer";
import {
  callStaticJudgmentOpenAI,
  parseStaticJudgmentResolution,
} from "./static-judgment";
import {
  compileStaticJudgmentSource,
  type StaticJudgmentCompilerResolution,
} from "./static-judgment-compiler";

async function main(): Promise<void> {
  const rawArguments = Bun.argv.slice(2);
  const [rawCommand, rawTarget] = rawArguments;
  if (
    !semanticCommands.some((command) => command === rawCommand) ||
    rawTarget === undefined
  ) {
    throw new Error(
      [
        "Usage:",
        "  bun run semantic build <semantic-source.ts> [--review] [--fixture <response.json>]",
        "  bun run semantic <replay|test> <semantic-source.ts>",
        "  bun run semantic check <semantic-source.ts> [--fixture <response.json>] [--samples 3 --quorum 2]",
        "  bun run semantic explain <semantic-source.ts> [--json]",
        "  bun run semantic closure <manifest.json> [--json]",
        "  bun run semantic verify <manifest.json> [--json]",
        "  bun run semantic diff <candidate-id>",
        "  bun run semantic approve <candidate-id> --reviewer <id>",
        "  bun run semantic tdd-plan <semantic-source.ts> [--test-fixture <result.json>]",
        "  bun run semantic tdd-build <semantic-source.ts> [--test-fixture <result.json>] [--fixture <response.json>]",
        "  bun run semantic tdd-replay <semantic-source.ts>",
        "  bun run semantic tdd-test <semantic-source.ts> [--json]",
      ].join("\n"),
    );
  }
  const parsedArguments = parseSemanticArguments(rawArguments);
  const { command, target, fixturePath, testFixturePath } = parsedArguments;

  if (command === "closure") {
    const report = await checkSemanticClosure({
      manifestPath: resolve(target),
    });
    console.log(
      parsedArguments.json
        ? JSON.stringify(report, null, 2)
        : renderSemanticClosure(report),
    );
    if (report.status === "open") process.exitCode = 2;
    return;
  }

  if (command === "verify") {
    const report = await verifySemanticArtifact({
      manifestPath: resolve(target),
    });
    console.log(
      parsedArguments.json
        ? JSON.stringify(report, null, 2)
        : renderSemanticVerify(report),
    );
    if (report.status === "failed") process.exitCode = 2;
    return;
  }

  if (command === "explain") {
    const explanation = await explainSemanticSource({
      sourcePath: resolve(target),
    });
    console.log(
      parsedArguments.json
        ? JSON.stringify(explanation, null, 2)
        : renderSemanticExplanation(explanation),
    );
    return;
  }

  if (command === "test") {
    const result = await runSemanticTests({
      sourcePath: resolve(target),
    });
    console.log(
      [
        `semantic test ${result.status}`,
        `source: ${result.source}`,
        `predicate: ${result.predicate}`,
        `generated: ${result.generated}`,
        `duration ms: ${result.durationMs}`,
        "api calls: 0",
        "files written: 0",
        ...(result.diagnostic === null
          ? []
          : [`diagnostic: ${result.diagnostic}`]),
      ].join("\n"),
    );
    if (result.status === "failed") process.exitCode = 2;
    return;
  }

  if (command === "tdd-test") {
    const result = await verifySemanticTddSource({
      sourcePath: resolve(target),
    });
    console.log(
      parsedArguments.json
        ? JSON.stringify(result, null, 2)
        : [
            "semantic tdd-test passed",
            `source: ${result.source}`,
            `predicate: ${result.predicate}`,
            `test plan: ${result.testPlanHash}`,
            `hard obligations: ${result.hardObligations}`,
            `mutation score: ${result.mutationScore}`,
            "api calls: 0",
            "files written: 0",
          ].join("\n"),
    );
    return;
  }

  if (command === "diff") {
    if (target.startsWith("test-review-")) {
      const { candidate, candidateDirectory, approval } =
        await readSemanticTestReviewCandidate(target);
      console.log(JSON.stringify(candidate.plan, null, 2));
      console.log(`candidate: ${candidate.id}`);
      console.log(
        `status: ${approval === null ? "review-required" : "approved"}`,
      );
      console.log(`contract: ${candidate.contractHash}`);
      console.log(`test plan: ${candidate.testPlanHash}`);
      console.log(`audit: ${candidateDirectory}`);
      return;
    }
    if (target.startsWith("review-")) {
      const { candidate, candidateDirectory, diff } =
        await readSemanticReviewCandidate(target);
      console.log(diff.trimEnd());
      console.log(`candidate: ${candidate.id}`);
      console.log(`kind: ${candidate.kind}`);
      console.log(`status: ${candidate.status}`);
      console.log(`audit: ${candidateDirectory}`);
      return;
    }
    const { candidate, candidateDirectory } =
      await readSemanticEvolutionCandidate(target);
    console.log(renderSemanticDiff(candidate.diff));
    console.log(`candidate: ${candidate.id}`);
    console.log(`status: ${candidate.status}`);
    console.log(`audit: ${candidateDirectory}`);
    return;
  }

  if (command === "approve") {
    const reviewer = parsedArguments.reviewer;
    if (reviewer === undefined) {
      throw new Error("semantic approve requires --reviewer <id>");
    }
    if (target.startsWith("test-review-")) {
      const result = await approveSemanticTestReview(target, { reviewer });
      console.log(
        [
          result.status === "already-approved"
            ? "Semantic Test Plan already approved"
            : "Semantic Test Plan approved and frozen",
          `candidate: ${result.candidate.id}`,
          `reviewer: ${result.approval.reviewer}`,
          `fingerprint: ${result.approval.fingerprint}`,
          `test lock: ${result.testLockPath}`,
        ].join("\n"),
      );
      return;
    }
    if (target.startsWith("review-")) {
      const result = await approveSemanticReview(target, { reviewer });
      console.log(
        [
          result.status === "already-approved"
            ? "semantic review already approved"
            : "semantic review approved",
          `candidate: ${result.candidate.id}`,
          `kind: ${result.candidate.kind}`,
          `reviewer: ${result.candidate.reviewer}`,
          `output: ${result.output}`,
          `fingerprint: ${result.candidate.fingerprint}`,
          ...(result.warning === null ? [] : [`warning: ${result.warning}`]),
        ].join("\n"),
      );
      return;
    }
    const result = await approveSemanticEvolution(target, { reviewer });
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
      const fixturePayload = await readBoundedJsonFile(
        absoluteFixture,
        "Static Judgment fixture",
      );
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
      const selectedModel = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
      model = selectedModel;
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
          { model: selectedModel, ...input },
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
      ...(parsedArguments.review ? { promotion: "review" as const } : {}),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(countsAsApiCall === undefined ? {} : { countsAsApiCall }),
      ...(resolver === undefined ? {} : { resolve: resolver }),
    });
    if (result.status === "review-required") {
      console.log(
        [
          "Static Judgment review required",
          `candidate: ${result.candidateId}`,
          `judgment: ${result.resolvedValue}`,
          `output: ${result.output}`,
          `provider/model: ${result.provider}/${result.model}`,
          `api calls: ${result.apiCalls}`,
          `cache hit: ${result.cacheHit}`,
          `sha256: ${result.generatedCodeHash}`,
          `audit: ${result.candidateDirectory}`,
          `report: ${result.report}`,
        ].join("\n"),
      );
      return;
    }
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

  if (
    (command === "build" || command === "check" || command === "tdd-build") &&
    fixturePath !== undefined
  ) {
    const absoluteFixture = resolve(fixturePath);
    const fixturePayload = await readBoundedJsonFile(
      absoluteFixture,
      "Predicate fixture",
    );
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
  } else if (
    command === "build" ||
    command === "check" ||
    command === "tdd-build"
  ) {
    const selectedModel = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    model = selectedModel;
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
          model: selectedModel,
          specification: input.specification,
          typeScriptSource: input.typeScriptSource,
          target: {
            functionName: input.functionName,
            parameterName: input.parameterName,
            typeName: input.typeName,
          },
          ...(input.projectContext === undefined
            ? {}
            : { projectContext: input.projectContext }),
        },
        connection,
      );
      return {
        elaboration: parseElaborationResult(
          JSON.parse(response.outputText) as unknown,
        ),
        response,
        rawOutput: JSON.parse(response.outputText) as unknown,
      };
    };
  }

  if (
    command === "tdd-plan" ||
    command === "tdd-build" ||
    command === "tdd-replay"
  ) {
    let resolveTestPlan:
      | Parameters<typeof createSemanticTestReviewCandidate>[0]["resolve"]
      | undefined;
    let testProvider: string | undefined;
    let testModel: string | undefined;
    let testCountsAsApiCall: boolean | undefined;
    if (
      (command === "tdd-plan" || command === "tdd-build") &&
      testFixturePath !== undefined
    ) {
      const absoluteTestFixture = resolve(testFixturePath);
      const fixturePayload = await readBoundedJsonFile(
        absoluteTestFixture,
        "Semantic Test fixture",
      );
      testProvider = `fixture:${basename(absoluteTestFixture)}`;
      testModel = "fixture-model";
      testCountsAsApiCall = false;
      resolveTestPlan = async (): Promise<SemanticTestSynthesisResolution> => ({
        synthesis: parseSemanticTestSynthesisResult(fixturePayload),
        response: null,
        rawOutput: fixturePayload,
      });
    } else if (command === "tdd-plan" || command === "tdd-build") {
      const tddModel =
        model ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
      const connection = resolveOpenAIConnection({
        apiKey: process.env.OPENAI_API_KEY ?? "",
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      });
      testProvider = connection.provider;
      testModel = tddModel;
      resolveTestPlan = async (
        input,
      ): Promise<SemanticTestSynthesisResolution> => {
        if (connection.apiKey.length === 0) {
          throw new Error(
            "OPENAI_API_KEY is required on a Semantic Test lock miss",
          );
        }
        const response = await callResponsesApi(
          buildSemanticTestSynthesisRequest({
            model: tddModel,
            contract: input.contract,
            contractHash: input.contractHash,
            typeScriptSource: input.typeScriptSource,
          }),
          connection,
        );
        const rawOutput = JSON.parse(response.outputText) as unknown;
        return {
          synthesis: parseSemanticTestSynthesisResult(rawOutput),
          response,
          rawOutput,
        };
      };
    }
    if (command === "tdd-plan") {
      if (
        testProvider === undefined ||
        testModel === undefined ||
        resolveTestPlan === undefined
      ) {
        throw new Error("Semantic Test Plan resolver configuration is missing");
      }
      const created = await createSemanticTestReviewCandidate({
        sourcePath: resolvedTarget,
        provider: testProvider,
        model: testModel,
        resolve: resolveTestPlan,
      });
      console.log(
        [
          "Semantic Test Plan review required",
          `candidate: ${created.candidate.id}`,
          `contract: ${created.candidate.contractHash}`,
          `test plan: ${created.candidate.testPlanHash}`,
          `api calls: ${created.apiCalls}`,
          `audit: ${created.candidateDirectory}`,
          `inspect: bun run semantic diff ${created.candidate.id}`,
          `approve: bun run semantic approve ${created.candidate.id} --reviewer <id>`,
        ].join("\n"),
      );
      return;
    }
    const result = await compileSemanticTddSource({
      sourcePath: resolvedTarget,
      mode: command === "tdd-build" ? "build" : "replay",
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(countsAsApiCall === undefined ? {} : { countsAsApiCall }),
      ...(testProvider === undefined ? {} : { testProvider }),
      ...(testModel === undefined ? {} : { testModel }),
      ...(testCountsAsApiCall === undefined ? {} : { testCountsAsApiCall }),
      ...(resolveTestPlan === undefined ? {} : { resolveTestPlan }),
      ...(resolver === undefined ? {} : { resolveImplementation: resolver }),
    });
    console.log(
      [
        `semantic ${command} ${result.status}`,
        `output: ${result.implementation.output}`,
        `test plan: ${result.testPlanHash}`,
        `test plan cache hit: ${result.testPlanCacheHit}`,
        `test api calls: ${result.testApiCalls}`,
        `implementation api calls: ${result.implementation.apiCalls}`,
        `mutation score: ${result.mutationScore}`,
        `test lock: ${result.testLock}`,
        `report: ${result.implementation.report}`,
      ].join("\n"),
    );
    return;
  }

  if (command === "check") {
    const samples = parsedArguments.samples ?? 3;
    const quorum = parsedArguments.quorum ?? (samples === 1 ? 1 : 2);
    if (
      provider === undefined ||
      model === undefined ||
      resolver === undefined
    ) {
      throw new Error("semantic check resolver configuration is missing");
    }
    const result = await checkSemanticEvolution({
      sourcePath: resolve(target),
      provider,
      model,
      ...(countsAsApiCall === undefined ? {} : { countsAsApiCall }),
      samples,
      quorum,
      resolve: resolver,
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
        `consensus: ${
          result.candidate.consensus === null
            ? "disabled"
            : `${result.candidate.consensus.supportingSamples.length}/${result.candidate.consensus.samples} (${result.candidate.consensus.reached ? "reached" : "unresolved"})`
        }`,
        `audit: ${result.candidateDirectory}`,
        result.candidate.status === "ready"
          ? `approve: bun run semantic approve ${result.candidate.id} --reviewer <id>`
          : "approve: unavailable",
      ].join("\n"),
    );
    return;
  }

  const result = await compileSemanticSource({
    sourcePath: resolvedTarget,
    mode: command === "build" ? "build" : "replay",
    ...(parsedArguments.review ? { promotion: "review" as const } : {}),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(countsAsApiCall === undefined ? {} : { countsAsApiCall }),
    ...(resolver === undefined ? {} : { resolve: resolver }),
  });

  if (result.status === "review-required") {
    console.log(
      [
        "semantic review required",
        `candidate: ${result.candidateId}`,
        `output: ${result.output}`,
        `provider/model: ${result.provider}/${result.model}`,
        `api calls: ${result.apiCalls}`,
        `cache hit: ${result.cacheHit}`,
        `sha256: ${result.generatedCodeHash}`,
        `audit: ${result.candidateDirectory}`,
        `report: ${result.report}`,
      ].join("\n"),
    );
    return;
  }
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

main().catch((error) => {
  const semanticError = normalizeSemanticError(error);
  const jsonRequested = Bun.argv.slice(2).includes("--json");
  console.error(
    jsonRequested
      ? JSON.stringify(semanticErrorJson(semanticError), null, 2)
      : renderSemanticError(semanticError),
  );
  process.exitCode = 1;
});
