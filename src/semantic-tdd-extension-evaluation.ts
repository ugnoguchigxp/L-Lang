import { open, readFile } from "node:fs/promises";
import { makeCodexTddResolver } from "./semantic-tdd-codex-resolver";
import { dirname, resolve } from "node:path";
import { resolveContainedFile } from "./contained-path";
import { parseElaborationResult } from "./elaboration-result";
import {
  buildOpenAIRequest,
  callResponsesApi,
  resolveOpenAIConnection,
} from "./openai";
import { compileSemanticContract } from "./semantic-contract";
import { sha256, stableJson } from "./semantic-fingerprint";
import {
  assertTextByteLength,
  parseBoundedJsonText,
  readBoundedJsonFile,
  SEMANTIC_LIMITS,
} from "./semantic-limits";
import {
  parsePropertyTestConfig,
  replayPropertyTest,
  runPropertyTest,
} from "./semantic-property-test";
import { scanSemanticSource } from "./semantic-source";
import { evaluatePredicateExpression } from "./semantic-test-generator";
import {
  parseSemanticTestPlan,
  validateSemanticTestPlan,
} from "./semantic-test-ir";
import {
  bestOfNRequest,
  collectBestOfNCandidates,
  evaluateBestOfN,
  parseBestOfNConfig,
  parseBestOfNReport,
  type BestOfNConfig,
  type SemanticTddBestOfNReport,
} from "./semantic-tdd-best-of-n";
import {
  extensionHash,
  extensionKeys,
  extensionNumber,
  extensionRecord,
} from "./semantic-tdd-extension-contract";

type Case = {
  id: string;
  source: string;
  plan: string;
  property: string;
  hidden: string;
  candidates: string;
};
type Metrics = {
  falseAcceptance: number;
  falseRejection: number;
  checked: number;
  unresolved: boolean;
  mutationKillRate: number | null;
};
type Row = {
  id: string;
  selection: SemanticTddBestOfNReport;
  single: Metrics;
  bestOfN: Metrics;
  property: ReturnType<typeof runPropertyTest> | null;
  propertyDefect: ReturnType<typeof runPropertyTest> | null;
  counterexampleReproduced: boolean | null;
  latencyMs: number;
};
export type ExtensionEvaluation = {
  version: 1;
  status: "completed" | "resource-stopped";
  stopReason: string | null;
  freezeHash: string;
  lane: "synthetic-control" | "live";
  model: string | null;
  config: BestOfNConfig;
  rows: Row[];
  totalTokens: number;
  estimatedCostUsd: number;
  apiCalls: number;
  limitations: string[];
};

function parseHiddenInput(
  input: unknown,
): import("./semantic-test-ir").SemanticTestValue {
  const plan = parseSemanticTestPlan({
    version: 1,
    contractHash: "a".repeat(64),
    obligations: [
      {
        id: "hidden",
        kind: "example",
        sourceClauses: ["requirements[0]"],
        strength: "hard",
        rationale: "Independent held-out label",
        input,
        expected: false,
      },
    ],
  });
  const row = plan.obligations[0];
  if (row === undefined || row.kind !== "example")
    throw new Error("invalid hidden input");
  return row.input;
}

async function loadBenchmark(path: string) {
  const root = dirname(resolve(path));
  const freeze = extensionRecord(
    await readBoundedJsonFile(
      resolve(root, "freeze.json"),
      "evaluation freeze",
    ),
    "freeze",
  );
  extensionKeys(freeze, ["version", "status", "purpose", "files"], "freeze");
  if (
    freeze.version !== 1 ||
    freeze.status !== "frozen" ||
    typeof freeze.purpose !== "string"
  )
    throw new Error("invalid evaluation freeze");
  const files = extensionRecord(freeze.files, "freeze.files");
  if (Object.keys(files).length > 256)
    throw new Error("freeze file budget exceeded");
  const snapshots = new Map<string, string>();
  for (const [file, hash] of Object.entries(files)) {
    const target = await resolveContainedFile(root, file, "frozen file", {
      rejectSymbolicLinks: true,
    });
    const text = await readFile(target, "utf8");
    assertTextByteLength(
      text,
      SEMANTIC_LIMITS.externalJsonBytes,
      "frozen input",
    );
    if (sha256(text) !== extensionHash(hash, "frozen hash"))
      throw new Error(`frozen evaluation input changed: ${file}`);
    snapshots.set(file, text);
  }
  async function read(file: string): Promise<unknown> {
    if (!Object.hasOwn(files, file))
      throw new Error("evaluation input is not frozen");
    const text = snapshots.get(file);
    if (text === undefined) throw new Error("missing frozen input snapshot");
    return parseBoundedJsonText(text, "evaluation input");
  }
  const benchmarkName = resolve(path).slice(root.length + 1);
  const v = extensionRecord(await read(benchmarkName), "benchmark");
  extensionKeys(v, ["version", "kind", "cases", "config"], "benchmark");
  if (
    v.version !== 1 ||
    v.kind !== "synthetic-control" ||
    !Array.isArray(v.cases) ||
    v.cases.length < 1 ||
    v.cases.length > 32
  )
    throw new Error("invalid evaluation benchmark");
  const cases = v.cases.map((value): Case => {
    const c = extensionRecord(value, "evaluation case");
    extensionKeys(
      c,
      ["id", "source", "plan", "property", "hidden", "candidates"],
      "evaluation case",
    );
    for (const [key, value] of Object.entries(c))
      if (
        typeof value !== "string" ||
        !value.length ||
        value.length > 128 ||
        (key !== "id" && !Object.hasOwn(files, value))
      )
        throw new Error("invalid/unfrozen evaluation case path");
    return c as Case;
  });
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("duplicate evaluation case");
  return {
    root,
    read,
    files,
    snapshots,
    cases,
    config: parseBestOfNConfig(v.config),
    freezeHash: sha256(stableJson(freeze)),
  };
}

function metrics(
  report: SemanticTddBestOfNReport,
  hidden: {
    input: import("./semantic-test-ir").SemanticTestValue;
    expected: boolean;
  }[],
): Metrics {
  const winner = report.trials.find((t) => t.id === report.selectedCandidate);
  const body =
    winner === undefined ? null : parseElaborationResult(winner.output).body;
  let falseAcceptance = 0,
    falseRejection = 0;
  if (body !== null)
    for (const row of hidden) {
      const actual = evaluatePredicateExpression(body, row.input);
      if (actual && !row.expected) falseAcceptance++;
      if (!actual && row.expected) falseRejection++;
    }
  const selected = report.candidates.find(
    (c) => c.id === report.selectedCandidate,
  );
  return {
    falseAcceptance,
    falseRejection,
    checked: body === null ? 0 : hidden.length,
    unresolved: body === null,
    mutationKillRate: selected?.mutationScore ?? null,
  };
}

export async function evaluateTddExtensions(options: {
  benchmarkPath: string;
  model?: string;
  config?: BestOfNConfig;
  previous?: ExtensionEvaluation;
  resolve?: Parameters<typeof collectBestOfNCandidates>[0]["resolve"];
  onSelection?: (selection: SemanticTddBestOfNReport) => Promise<void>;
}): Promise<ExtensionEvaluation> {
  const benchmark = await loadBenchmark(options.benchmarkPath);
  const previous = options.previous;
  if (previous !== undefined) {
    const v = extensionRecord(previous, "evaluation report");
    if (
      v.version !== 1 ||
      !["live", "synthetic-control"].includes(String(v.lane)) ||
      (v.lane === "live"
        ? typeof v.model !== "string" || !v.model.trim()
        : v.model !== null) ||
      !Array.isArray(v.rows) ||
      v.rows.length > benchmark.cases.length
    )
      throw new Error("invalid evaluation metadata");
    for (const row of previous.rows)
      extensionNumber(
        row.latencyMs,
        0,
        Number.MAX_VALUE,
        "evaluation latencyMs",
      );
  }
  if (options.model !== undefined && !options.model.trim())
    throw new Error("evaluation model must be nonempty");
  const live =
    previous === undefined
      ? options.model !== undefined
      : previous.lane === "live";
  const config = parseBestOfNConfig(
    previous?.config ?? options.config ?? benchmark.config,
  );
  if (
    live &&
    (config.inputUsdPerMillionTokens <= 0 ||
      config.outputUsdPerMillionTokens <= 0)
  )
    throw new Error(
      "live evaluation requires explicit positive declared token prices",
    );
  if (previous !== undefined && previous.freezeHash !== benchmark.freezeHash)
    throw new Error("evaluation freeze mismatch");
  if (
    live &&
    previous === undefined &&
    options.resolve === undefined &&
    !process.env.OPENAI_API_KEY
  )
    throw new Error("OPENAI_API_KEY is required for live evaluation");
  const rows: Row[] = [];
  let stopReason: string | null = null;
  let tokens = 0,
    cost = 0,
    calls = 0;
  const sourceCache = new Map<
    string,
    Awaited<ReturnType<typeof scanSemanticSource>>
  >();
  // Parse every source before provider calls, and bind the scanner result to the frozen bytes.
  for (const c of benchmark.cases) {
    let source = sourceCache.get(c.source);
    if (source === undefined) {
      source = await scanSemanticSource(
        await resolveContainedFile(
          benchmark.root,
          c.source,
          "evaluation source",
        ),
      );
      if (source.sourceText !== benchmark.snapshots.get(c.source))
        throw new Error(`frozen evaluation input changed: ${c.source}`);
      sourceCache.set(c.source, source);
    }
  }
  for (const c of benchmark.cases) {
    const started = performance.now();
    const source = sourceCache.get(c.source);
    if (source === undefined) throw new Error("missing frozen source snapshot");
    const contract = compileSemanticContract(source);
    const validated = validateSemanticTestPlan(
      parseSemanticTestPlan(await benchmark.read(c.plan)),
      contract.contract,
      contract.contractHash,
    );
    const request = bestOfNRequest(
      {
        specification: source.concept.specification,
        typeScriptSource: source.concept.typeDeclaration,
        functionName: source.predicate.name,
        parameterName: source.predicate.parameterName,
        typeName: source.concept.typeName,
      },
      validated,
    );
    const remainingTokens = config.maxTotalTokens - tokens;
    const remainingCost = config.maxCostUsd - cost;
    if (remainingTokens < 1 || remainingCost < 0.000001) {
      stopReason = "evaluation total resource budget exhausted";
      break;
    }
    const caseConfig = {
      ...config,
      maxTotalTokens: remainingTokens,
      maxCostUsd: remainingCost,
    };
    const saved = previous?.rows.find((row) => row.id === c.id);
    if (previous !== undefined && saved === undefined)
      throw new Error("missing evaluation row");
    let selection: SemanticTddBestOfNReport;
    if (saved !== undefined) {
      const parsed = parseBestOfNReport(saved.selection);
      if (
        parsed.fixture !== !live ||
        stableJson(parsed.config) !== stableJson(caseConfig)
      )
        throw new Error("evaluation resource configuration mismatch");
      if (stableJson(parsed.request) !== stableJson(request))
        throw new Error("evaluation request mismatch");
      selection = evaluateBestOfN({
        source,
        validated,
        config: parsed.config,
        request,
        fixture: !live,
        trials: parsed.trials,
        resourceFailure: parsed.resourceFailure,
      }).report;
      if (stableJson(selection) !== stableJson(parsed))
        throw new Error("evaluation selection replay mismatch");
    } else {
      const fixtures = await benchmark.read(c.candidates);
      if (!Array.isArray(fixtures) || fixtures.length !== config.candidates)
        throw new Error("fixture count mismatch");
      let index = 0;
      const collected = await collectBestOfNCandidates({
        config: caseConfig,
        request,
        fixture: !live,
        resolve: async (r, limits) => {
          if (!live) {
            const output = fixtures[index++];
            if (output === null)
              throw new Error("synthetic partial provider failure");
            return { elaboration: output, rawOutput: output, response: null };
          }
          if (options.resolve !== undefined) return options.resolve(r, limits);
          const connection = resolveOpenAIConnection({
            apiKey: process.env.OPENAI_API_KEY ?? "",
            baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
          });
          if (!connection.apiKey)
            throw new Error("OPENAI_API_KEY is required for live evaluation");
          const model = options.model;
          if (model === undefined) throw new Error("missing evaluation model");
          const response = await callResponsesApi(
            buildOpenAIRequest({
              model,
              specification: r.specification,
              typeScriptSource: r.typeScriptSource,
              target: {
                functionName: r.functionName,
                parameterName: r.parameterName,
                typeName: r.typeName,
              },
              maxOutputTokens: limits.maxOutputTokens,
            }),
            connection,
            limits.signal,
          );
          let output: unknown;
          try {
            output = JSON.parse(response.outputText);
          } catch {
            output = response.outputText;
          }
          return { elaboration: output, rawOutput: output, response };
        },
      });
      selection = evaluateBestOfN({
        source,
        validated,
        config: caseConfig,
        request,
        fixture: !live,
        ...collected,
      }).report;
    }
    await options.onSelection?.(structuredClone(selection));
    tokens += selection.totalTokens;
    cost += selection.estimatedCostUsd;
    calls += selection.apiCalls;
    // The paired baseline uses the first identical-request draw; no hidden input enters either ranking.
    const first = selection.trials[0];
    if (first === undefined)
      throw new Error("missing single candidate baseline");
    const single = evaluateBestOfN({
      source,
      validated,
      config: { ...selection.config, candidates: 1 },
      request,
      fixture: !live,
      trials: [first],
      resourceFailure: !live
        ? null
        : (() => {
            const usage = first.response?.usage;
            if (first.failure === "provider-error") return "unknown-call-usage";
            if (usage === null || usage === undefined) return "missing-usage";
            const firstCost =
              (usage.inputTokens * caseConfig.inputUsdPerMillionTokens +
                usage.outputTokens * caseConfig.outputUsdPerMillionTokens) /
              1_000_000;
            if (firstCost > caseConfig.maxCostUsd) return "cost-budget";
            if (usage.totalTokens > caseConfig.maxTotalTokens)
              return "total-token-budget";
            if (usage.outputTokens > caseConfig.maxOutputTokensPerCall)
              return "output-token-budget";
            return null;
          })(),
    }).report;
    // Hidden labels are loaded only AFTER selection, never passed to either candidate resolver.
    const hiddenInput = await benchmark.read(c.hidden);
    if (
      !Array.isArray(hiddenInput) ||
      hiddenInput.length < 1 ||
      hiddenInput.length > 4096
    )
      throw new Error("invalid hidden case count");
    const hidden = hiddenInput.map((value) => {
      const h = extensionRecord(value, "hidden case");
      extensionKeys(h, ["input", "expected"], "hidden case");
      if (typeof h.expected !== "boolean")
        throw new Error("invalid hidden expected");
      return { input: parseHiddenInput(h.input), expected: h.expected };
    });
    const propertyConfig = parsePropertyTestConfig(
      await benchmark.read(c.property),
    );
    const winner = selection.trials.find(
      (t) => t.id === selection.selectedCandidate,
    );
    const expression =
      winner === undefined ? null : parseElaborationResult(winner.output).body;
    const property =
      expression === null
        ? null
        : runPropertyTest({
            schema: source.concept.typeSchema,
            config: propertyConfig,
            expression,
            plan: validated.plan,
          });
    const fixtureCandidates = (await benchmark.read(c.candidates)) as unknown[];
    const defect = fixtureCandidates.find(
      (value) =>
        value !== null &&
        stableJson(parseElaborationResult(value).body) !==
          stableJson(propertyConfig.expected),
    );
    const defectExpression =
      defect === undefined ? null : parseElaborationResult(defect).body;
    const propertyDefect =
      defectExpression === null
        ? null
        : runPropertyTest({
            schema: source.concept.typeSchema,
            config: propertyConfig,
            expression: defectExpression,
            plan: validated.plan,
          });
    const counterexampleReproduced =
      propertyDefect === null || propertyDefect.status !== "failed"
        ? null
        : stableJson(replayPropertyTest(propertyDefect)) ===
          stableJson(propertyDefect);
    rows.push({
      id: c.id,
      selection,
      single: metrics(single, hidden),
      bestOfN: metrics(selection, hidden),
      property,
      propertyDefect,
      counterexampleReproduced,
      latencyMs: saved?.latencyMs ?? performance.now() - started,
    });
    if (selection.resourceFailure !== null) {
      stopReason = selection.resourceFailure;
      break;
    }
  }
  const result: ExtensionEvaluation = {
    version: 1,
    status: stopReason === null ? "completed" : "resource-stopped",
    stopReason,
    freezeHash: benchmark.freezeHash,
    lane: live ? "live" : "synthetic-control",
    model: previous?.model ?? options.model ?? null,
    config,
    rows,
    totalTokens: tokens,
    estimatedCostUsd: cost,
    apiCalls: calls,
    limitations: [
      "New synthetic controls; not a blind third-party quality study.",
      "Single baseline is the first draw of the same Best-of-N batch; results are paired, not independent draws.",
      "IR selection only; generated-code transaction integrity is covered separately by integration tests.",
      "Declared-price accounting after responses is not an absolute provider billing cap.",
      "Unknown provider usage is fail-closed; totals include observed usage only.",
      "Live budget is shared across the entire evaluation; a budget failure aborts promotion, but can consume the current provider response.",
    ],
  };
  if (previous !== undefined && stableJson(result) !== stableJson(previous))
    throw new Error("evaluation replay mismatch");
  return result;
}

async function main() {
  const [mode, benchmarkPath, output, ...args] = Bun.argv.slice(2);
  if (
    !["fixture", "live", "codex", "replay"].includes(mode ?? "") ||
    benchmarkPath === undefined ||
    output === undefined
  )
    throw new Error(
      "Usage: semantic:extensions:evaluate fixture <benchmark.json> <new-report.json> | live <benchmark.json> <new-report.json> <model> <budget-config.json> | codex <benchmark.json> <new-report.json> gpt-6-luna <budget-config.json> | replay <benchmark.json> <report.json>",
    );
  let result: ExtensionEvaluation;
  if (mode === "replay") {
    if (args.length) throw new Error("replay accepts no options");
    result = await evaluateTddExtensions({
      benchmarkPath,
      previous: (await readBoundedJsonFile(
        resolve(output),
        "evaluation report",
        16 * 1024 * 1024,
      )) as ExtensionEvaluation,
    });
  } else {
    if (
      (mode === "live" || mode === "codex") &&
      (args.length !== 2 || !args[0] || !args[1])
    )
      throw new Error("live requires explicit model and budget config");
    if (mode === "fixture" && args.length)
      throw new Error("fixture accepts no options");
    const handle = await open(resolve(output), "wx", 0o600);
    const audit: SemanticTddBestOfNReport[] = [];
    try {
      let liveOptions: { model: string; config: BestOfNConfig } | undefined;
      if (mode === "live" || mode === "codex") {
        const [model, budgetPath] = args;
        if (model === undefined || budgetPath === undefined)
          throw new Error("missing live model or budget");
        liveOptions = {
          model,
          config: parseBestOfNConfig(
            await readBoundedJsonFile(resolve(budgetPath), "budget config"),
          ),
        };
      }
      result = await evaluateTddExtensions({
        benchmarkPath,
        onSelection: async (selection) => {
          audit.push(selection);
          const checkpoint = `${JSON.stringify(
            { version: 1, status: "incomplete", selections: audit },
            null,
            2,
          )}\n`;
          await handle.write(checkpoint, 0, "utf8");
          await handle.truncate(Buffer.byteLength(checkpoint));
          await handle.sync();
        },
        ...liveOptions,
        ...(mode === "codex" && liveOptions !== undefined
          ? { resolve: makeCodexTddResolver(liveOptions.model) }
          : {}),
      });
      const text = `${JSON.stringify(result, null, 2)}\n`;
      assertTextByteLength(text, 16 * 1024 * 1024, "evaluation report");
      await handle.write(text, 0, "utf8");
      await handle.truncate(Buffer.byteLength(text));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  process.exitCode = result.status === "completed" ? 0 : 1;
  console.log(
    JSON.stringify(
      {
        status: result.status,
        stopReason: result.stopReason,
        lane: result.lane,
        rows: result.rows.length,
        apiCalls: mode === "replay" ? 0 : result.apiCalls,
        totalTokens: result.totalTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        singleUnresolved: result.rows.filter((r) => r.single.unresolved).length,
        bestOfNUnresolved: result.rows.filter((r) => r.bestOfN.unresolved)
          .length,
        falseAcceptance: result.rows.reduce(
          (n, r) => n + r.bestOfN.falseAcceptance,
          0,
        ),
        falseRejection: result.rows.reduce(
          (n, r) => n + r.bestOfN.falseRejection,
          0,
        ),
        counterexamplesReproduced: result.rows.filter(
          (r) => r.counterexampleReproduced,
        ).length,
      },
      null,
      2,
    ),
  );
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
