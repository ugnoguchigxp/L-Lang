import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { sha256 } from "./semantic-fingerprint";
import {
  assertKnownKeys,
  parseBoundedJsonText,
  readBoundedJsonFile,
  SEMANTIC_LIMITS,
} from "./semantic-limits";

export type ProjectFitArm = "typeOnly" | "projectContext";
export type ProjectFitStage = "initial" | "schemaChange";

export type ProjectFitManifest = {
  version: 2;
  name: string;
  trials: number;
  freeze: string;
  budget: {
    maxApiCalls: number;
    maxInputTokens: number;
    maxOutputTokensPerCall: number;
    maxTotalOutputTokens: number;
    maxEstimatedCost: number;
  };
  thresholds: {
    minProjectContextFirstPassCases: number;
    minFirstPassDeltaCases: number;
    maxFalseResolutionDelta: number;
    maxUnresolvedRateRegression: number;
    maxLatencyDeltaMs: number;
  };
  cases: ProjectFitCase[];
};

export type ProjectFitCase = {
  id: string;
  domain: string;
  stages: Record<
    ProjectFitStage,
    {
      modelInput: string;
      projectContext: string;
      oracle: string;
      fixtures: Record<ProjectFitArm, string>;
    }
  >;
};

export type ProjectFitFreeze = {
  version: 2;
  status: "draft" | "frozen";
  instructions: string;
  files: Record<string, string>;
};

export type ProjectFitProtocol = {
  directory: string;
  manifestPath: string;
  manifest: ProjectFitManifest;
  freezePath: string;
  freeze: ProjectFitFreeze;
  manifestHash: string;
};

export type ProjectFitModelInput = {
  version: 2;
  intent: string;
  target: {
    functionName: string;
    parameterName: string;
    typeName: string;
    typeScriptSource: string;
  };
};

export type ProjectFitOracle = {
  version: 2;
  hiddenCases: Array<{
    name: string;
    input: Record<string, unknown>;
    expected: boolean;
  }>;
};

export function parseProjectFitModelInput(
  input: unknown,
  path = "Project Fit model input",
): ProjectFitModelInput {
  const value = recordValue(input, path);
  assertExactKeys(value, ["version", "intent", "target"], path);
  if (value.version !== 2) {
    throw new Error(`${path}.version must be 2`);
  }
  const targetPath = `${path}.target`;
  const target = recordValue(value.target, targetPath);
  assertExactKeys(
    target,
    ["functionName", "parameterName", "typeName", "typeScriptSource"],
    targetPath,
  );
  return {
    version: 2,
    intent: trimmedString(value.intent, `${path}.intent`),
    target: {
      functionName: trimmedString(
        target.functionName,
        `${targetPath}.functionName`,
      ),
      parameterName: trimmedString(
        target.parameterName,
        `${targetPath}.parameterName`,
      ),
      typeName: trimmedString(target.typeName, `${targetPath}.typeName`),
      typeScriptSource: trimmedString(
        target.typeScriptSource,
        `${targetPath}.typeScriptSource`,
      ),
    },
  };
}

export function parseProjectFitOracle(
  input: unknown,
  path = "Project Fit oracle",
): ProjectFitOracle {
  const value = recordValue(input, path);
  assertExactKeys(value, ["version", "hiddenCases"], path);
  if (value.version !== 2) {
    throw new Error(`${path}.version must be 2`);
  }
  if (!Array.isArray(value.hiddenCases) || value.hiddenCases.length === 0) {
    throw new Error(`${path}.hiddenCases must be a non-empty array`);
  }
  if (value.hiddenCases.length > 64) {
    throw new Error(`${path}.hiddenCases must contain at most 64 items`);
  }
  const hiddenCases = value.hiddenCases.map((hiddenCase, index) => {
    const itemPath = `${path}.hiddenCases[${index}]`;
    const item = recordValue(hiddenCase, itemPath);
    assertExactKeys(item, ["name", "input", "expected"], itemPath);
    if (typeof item.expected !== "boolean") {
      throw new Error(`${itemPath}.expected must be a boolean`);
    }
    return {
      name: trimmedString(item.name, `${itemPath}.name`),
      input: recordValue(item.input, `${itemPath}.input`),
      expected: item.expected,
    };
  });
  return {
    version: 2,
    hiddenCases,
  };
}

export function parseProjectFitManifest(input: unknown): ProjectFitManifest {
  const value = recordValue(input, "project fit manifest");
  assertExactKeys(
    value,
    ["version", "name", "trials", "freeze", "budget", "thresholds", "cases"],
    "project fit manifest",
  );
  if (value.version !== 2) {
    throw new Error("project fit manifest.version must be 2");
  }
  const name = trimmedString(value.name, "project fit manifest.name");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error("project fit manifest.name must be a portable identifier");
  }
  const trials = positiveInteger(value.trials, "project fit manifest.trials");
  if (trials > 10) {
    throw new Error("project fit manifest.trials must be at most 10");
  }
  const freeze = relativePathValue(value.freeze, "project fit manifest.freeze");
  const budgetValue = recordValue(value.budget, "project fit manifest.budget");
  const thresholdsValue = recordValue(
    value.thresholds,
    "project fit manifest.thresholds",
  );
  assertExactKeys(
    thresholdsValue,
    [
      "minProjectContextFirstPassCases",
      "minFirstPassDeltaCases",
      "maxFalseResolutionDelta",
      "maxUnresolvedRateRegression",
      "maxLatencyDeltaMs",
    ],
    "project fit manifest.thresholds",
  );
  const thresholds = {
    minProjectContextFirstPassCases: nonNegativeInteger(
      thresholdsValue.minProjectContextFirstPassCases,
      "project fit manifest.thresholds.minProjectContextFirstPassCases",
    ),
    minFirstPassDeltaCases: nonNegativeInteger(
      thresholdsValue.minFirstPassDeltaCases,
      "project fit manifest.thresholds.minFirstPassDeltaCases",
    ),
    maxFalseResolutionDelta: nonNegativeInteger(
      thresholdsValue.maxFalseResolutionDelta,
      "project fit manifest.thresholds.maxFalseResolutionDelta",
    ),
    maxUnresolvedRateRegression: unitInterval(
      thresholdsValue.maxUnresolvedRateRegression,
      "project fit manifest.thresholds.maxUnresolvedRateRegression",
    ),
    maxLatencyDeltaMs: nonNegativeNumber(
      thresholdsValue.maxLatencyDeltaMs,
      "project fit manifest.thresholds.maxLatencyDeltaMs",
    ),
  };
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("project fit manifest.cases must be a non-empty array");
  }
  if (value.cases.length > 64) {
    throw new Error("project fit manifest.cases must contain at most 64 items");
  }
  const cases = value.cases.map((inputCase, index) =>
    parseCase(inputCase, index),
  );
  const ids = new Set<string>();
  for (const entry of cases) {
    if (ids.has(entry.id)) {
      throw new Error(
        `project fit manifest contains duplicate case ${entry.id}`,
      );
    }
    ids.add(entry.id);
  }
  const expectedApiCalls = cases.length * trials * 2 * 2;
  if (thresholds.minProjectContextFirstPassCases > cases.length) {
    throw new Error(
      "project fit manifest threshold exceeds the number of cases",
    );
  }
  const budget = parseProjectFitBudget(budgetValue);
  assertProjectFitApiCallBudget(budget.maxApiCalls, expectedApiCalls);
  if (
    budget.maxOutputTokensPerCall >
    Math.floor(budget.maxTotalOutputTokens / expectedApiCalls)
  ) {
    throw new Error(
      `project fit manifest aggregate output token budget cannot cover ${expectedApiCalls} calls at ${budget.maxOutputTokensPerCall} tokens per call`,
    );
  }
  return {
    version: 2,
    name,
    trials,
    freeze,
    budget,
    thresholds,
    cases,
  };
}

export function parseProjectFitFreeze(input: unknown): ProjectFitFreeze {
  const value = recordValue(input, "project fit freeze");
  assertExactKeys(
    value,
    ["version", "status", "instructions", "files"],
    "project fit freeze",
  );
  if (value.version !== 2) {
    throw new Error("project fit freeze.version must be 2");
  }
  if (value.status !== "draft" && value.status !== "frozen") {
    throw new Error("project fit freeze.status must be draft or frozen");
  }
  const instructions = trimmedString(
    value.instructions,
    "project fit freeze.instructions",
  );
  const filesValue = recordValue(value.files, "project fit freeze.files");
  const files: Record<string, string> = {};
  for (const [file, hashInput] of Object.entries(filesValue)) {
    const normalized = relativePathValue(file, "project fit freeze file");
    if (normalized !== file) {
      throw new Error(`project fit freeze file must be normalized: ${file}`);
    }
    if (typeof hashInput !== "string" || !/^[a-f0-9]{64}$/.test(hashInput)) {
      throw new Error(`project fit freeze hash is invalid: ${file}`);
    }
    files[file] = hashInput;
  }
  if (Object.keys(files).length === 0) {
    throw new Error("project fit freeze.files must not be empty");
  }
  return {
    version: 2,
    status: value.status,
    instructions,
    files,
  };
}

export async function readProjectFitProtocol(
  manifestPathInput: string,
): Promise<ProjectFitProtocol> {
  const manifestPath = await realpath(resolve(manifestPathInput));
  const directory = dirname(manifestPath);
  const manifestData = await readFile(manifestPath);
  if (manifestData.byteLength > SEMANTIC_LIMITS.externalJsonBytes) {
    throw new Error("Project Fit manifest exceeds input budget");
  }
  const manifest = parseProjectFitManifest(
    parseBoundedJsonText(
      manifestData.toString("utf8"),
      "Project Fit manifest",
      SEMANTIC_LIMITS.externalJsonBytes,
    ),
  );
  const freezePath = await resolveContainedFile(
    directory,
    manifest.freeze,
    "Project Fit freeze",
  );
  const freeze = parseProjectFitFreeze(
    await readBoundedJsonFile(freezePath, "Project Fit freeze"),
  );
  if (freeze.version !== manifest.version) {
    throw new Error("project fit manifest and freeze versions must match");
  }
  const requiredFiles = requiredProtocolFiles(manifest, basename(manifestPath));
  const frozenFiles = Object.keys(freeze.files).sort();
  if (
    requiredFiles.length !== frozenFiles.length ||
    requiredFiles.some((file, index) => file !== frozenFiles[index])
  ) {
    throw new Error(
      "project fit freeze files must exactly match manifest inputs",
    );
  }
  for (const [file, expectedHash] of Object.entries(freeze.files)) {
    const absolute = await resolveContainedFile(
      directory,
      file,
      `Project Fit input ${file}`,
    );
    const data = await readFile(absolute);
    if (data.byteLength > SEMANTIC_LIMITS.externalJsonBytes) {
      throw new Error(`Project Fit input ${file} exceeds input budget`);
    }
    if (sha256(data) !== expectedHash) {
      throw new Error(`Project Fit frozen input changed: ${file}`);
    }
  }
  return {
    directory,
    manifestPath,
    manifest,
    freezePath,
    freeze,
    manifestHash: sha256(manifestData),
  };
}

export async function readProjectFitFrozenJson(
  protocol: ProjectFitProtocol,
  file: string,
  label: string,
): Promise<unknown> {
  const expectedHash = protocol.freeze.files[file];
  if (expectedHash === undefined) {
    throw new Error(`${label} is not part of the frozen Project Fit input`);
  }
  const absolute = await resolveContainedFile(protocol.directory, file, label);
  const data = await readFile(absolute);
  if (data.byteLength > SEMANTIC_LIMITS.externalJsonBytes) {
    throw new Error(`${label} exceeds input budget`);
  }
  if (sha256(data) !== expectedHash) {
    throw new Error(`${label} changed after protocol verification`);
  }
  return parseBoundedJsonText(
    data.toString("utf8"),
    label,
    SEMANTIC_LIMITS.externalJsonBytes,
  );
}

export function assertProjectFitFrozen(freeze: ProjectFitFreeze): void {
  if (freeze.status !== "frozen") {
    throw new Error("Project Fit inputs must be frozen before live execution");
  }
}

export function requiredProtocolFiles(
  manifest: ProjectFitManifest,
  manifestFile = "benchmark.json",
): string[] {
  return [
    manifestFile,
    ...manifest.cases.flatMap((entry) =>
      (["initial", "schemaChange"] as const).flatMap((stage) => {
        const files = entry.stages[stage];
        return [
          files.modelInput,
          files.projectContext,
          files.oracle,
          files.fixtures.typeOnly,
          files.fixtures.projectContext,
        ];
      }),
    ),
  ]
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
}

export function projectFitTotalOutputTokenBudget(
  manifest: ProjectFitManifest,
): number {
  return manifest.budget.maxTotalOutputTokens;
}

export function projectFitPerCallOutputTokenLimit(
  manifest: ProjectFitManifest,
): number {
  return manifest.budget.maxOutputTokensPerCall;
}

function parseProjectFitBudget(
  value: Record<string, unknown>,
): ProjectFitManifest["budget"] {
  const path = "project fit manifest.budget";
  assertExactKeys(
    value,
    [
      "maxApiCalls",
      "maxInputTokens",
      "maxOutputTokensPerCall",
      "maxTotalOutputTokens",
      "maxEstimatedCost",
    ],
    path,
  );
  return {
    maxApiCalls: nonNegativeInteger(value.maxApiCalls, `${path}.maxApiCalls`),
    maxInputTokens: nonNegativeInteger(
      value.maxInputTokens,
      `${path}.maxInputTokens`,
    ),
    maxOutputTokensPerCall: positiveInteger(
      value.maxOutputTokensPerCall,
      `${path}.maxOutputTokensPerCall`,
    ),
    maxTotalOutputTokens: positiveInteger(
      value.maxTotalOutputTokens,
      `${path}.maxTotalOutputTokens`,
    ),
    maxEstimatedCost: nonNegativeNumber(
      value.maxEstimatedCost,
      `${path}.maxEstimatedCost`,
    ),
  };
}

function assertProjectFitApiCallBudget(
  maxApiCalls: number,
  expectedApiCalls: number,
): void {
  if (maxApiCalls < expectedApiCalls) {
    throw new Error(
      `project fit manifest budget requires at least ${expectedApiCalls} API calls`,
    );
  }
}

async function resolveContainedFile(
  directory: string,
  file: string,
  label: string,
): Promise<string> {
  const normalized = relativePathValue(file, label);
  const root = await realpath(directory);
  const target = await realpath(resolve(root, normalized));
  const relation = relative(root, target).replaceAll("\\", "/");
  if (relation === ".." || relation.startsWith("../") || isAbsolute(relation)) {
    throw new Error(`${label} must stay inside the benchmark directory`);
  }
  return target;
}

function parseCase(input: unknown, index: number): ProjectFitCase {
  const path = `project fit manifest.cases[${index}]`;
  const value = recordValue(input, path);
  assertExactKeys(value, ["id", "domain", "stages"], path);
  const stagesValue = recordValue(value.stages, `${path}.stages`);
  assertExactKeys(stagesValue, ["initial", "schemaChange"], `${path}.stages`);
  return {
    id: trimmedString(value.id, `${path}.id`),
    domain: trimmedString(value.domain, `${path}.domain`),
    stages: {
      initial: parseStageFiles(stagesValue.initial, `${path}.stages.initial`),
      schemaChange: parseStageFiles(
        stagesValue.schemaChange,
        `${path}.stages.schemaChange`,
      ),
    },
  };
}

function parseStageFiles(
  input: unknown,
  path: string,
): ProjectFitCase["stages"][ProjectFitStage] {
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    ["modelInput", "projectContext", "oracle", "fixtures"],
    path,
  );
  const fixtures = recordValue(value.fixtures, `${path}.fixtures`);
  assertExactKeys(fixtures, ["typeOnly", "projectContext"], `${path}.fixtures`);
  return {
    modelInput: relativePathValue(value.modelInput, `${path}.modelInput`),
    projectContext: relativePathValue(
      value.projectContext,
      `${path}.projectContext`,
    ),
    oracle: relativePathValue(value.oracle, `${path}.oracle`),
    fixtures: {
      typeOnly: relativePathValue(
        fixtures.typeOnly,
        `${path}.fixtures.typeOnly`,
      ),
      projectContext: relativePathValue(
        fixtures.projectContext,
        `${path}.fixtures.projectContext`,
      ),
    },
  };
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  assertKnownKeys(value, keys, path);
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) {
    throw new Error(`${path} is missing ${missing}`);
  }
}

function recordValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function trimmedString(input: unknown, path: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.trim() !== input
  ) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return input;
}

function relativePathValue(input: unknown, path: string): string {
  const value = trimmedString(input, path).replaceAll("\\", "/");
  if (
    isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("/../") ||
    value.startsWith("./") ||
    value.endsWith("/")
  ) {
    throw new Error(`${path} must be a normalized relative path`);
  }
  return value;
}

function positiveInteger(input: unknown, path: string): number {
  const value = nonNegativeInteger(input, path);
  if (value === 0) throw new Error(`${path} must be positive`);
  return value;
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return input;
}

function nonNegativeNumber(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
  return input;
}

function unitInterval(input: unknown, path: string): number {
  const value = nonNegativeNumber(input, path);
  if (value > 1) throw new Error(`${path} must be at most 1`);
  return value;
}
