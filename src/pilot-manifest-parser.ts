import { isAbsolute } from "node:path";

import { assertKnownKeys } from "./semantic-limits";

export type PilotManifest = {
  version: 1;
  id: string;
  freeze: string;
  review: string;
  domains: string[];
  projectFiles: string[];
  cases: PilotCase[];
  budget: {
    maxApiCalls: number;
    maxEstimatedCost: number;
    maxWallClockMs: number;
    maxResponseOutputTokens: number;
    cooldownMsAfterEveryAttempt: 60_000;
  };
  execution: {
    mode: "shadow";
    businessWritesAllowed: false;
    externalIoAllowed: false;
  };
  thresholds: {
    minFirstPassProjectFitRate: number;
    maxUnresolvedRate: number;
    maxFalseResolutions: 0;
  };
};

export type PilotCase = {
  id: string;
  domain: string;
  source: string;
  baseline: string;
  hiddenCases: string;
  schemaEvolutionSource: string;
  fixture: string;
  risk: "low";
  owner: string;
};

export type PilotFreeze = {
  version: 1;
  status: "draft" | "frozen" | "completed";
  instructions: string;
  files: Record<string, string>;
};

export type PilotReview = {
  version: 1;
  status: "draft" | "approved";
  reviewer: {
    name: string | null;
    role: string | null;
    independentFromImplementation: boolean;
  };
  reviewedAt: string | null;
  decisions: {
    businessDefinitionsApproved: boolean;
    baselinesApproved: boolean;
    hiddenCasesApproved: boolean;
    schemaChangesApproved: boolean;
    syntheticDataOnly: boolean;
    advisoryOnly: boolean;
    budgetApproved: boolean;
    stopAuthorityConfirmed: boolean;
    goNoGoAuthorityConfirmed: boolean;
  };
  cases: Array<{
    caseId: string;
    owner: string;
    risk: "low";
    approved: boolean;
  }>;
};

export function parsePilotManifest(input: unknown): PilotManifest {
  const value = recordValue(input, "pilot manifest");
  assertExactKeys(
    value,
    [
      "version",
      "id",
      "freeze",
      "review",
      "domains",
      "projectFiles",
      "cases",
      "budget",
      "execution",
      "thresholds",
    ],
    "pilot manifest",
  );
  if (value.version !== 1) {
    throw new Error("pilot manifest.version must be 1");
  }
  const id = portableId(value.id, "pilot manifest.id");
  const domains = stringArray(value.domains, "pilot manifest.domains", 1, 16);
  assertUnique(domains, "pilot manifest.domains");
  const projectFiles = pathArray(
    value.projectFiles,
    "pilot manifest.projectFiles",
    1,
    128,
  );
  assertUnique(projectFiles, "pilot manifest.projectFiles");
  if (!Array.isArray(value.cases) || value.cases.length !== 8) {
    throw new Error("pilot manifest.cases must contain exactly 8 cases");
  }
  const cases = value.cases.map((entry, index) => parsePilotCase(entry, index));
  assertUnique(
    cases.map((entry) => entry.id),
    "pilot manifest case ids",
  );
  for (const entry of cases) {
    if (!domains.includes(entry.domain)) {
      throw new Error(
        `pilot manifest case ${entry.id} uses unknown domain ${entry.domain}`,
      );
    }
  }
  const budget = parseBudget(value.budget);
  if (budget.maxApiCalls < cases.length) {
    throw new Error(
      `pilot manifest budget requires at least ${cases.length} API calls`,
    );
  }
  return {
    version: 1,
    id,
    freeze: relativePathValue(value.freeze, "pilot manifest.freeze"),
    review: relativePathValue(value.review, "pilot manifest.review"),
    domains,
    projectFiles,
    cases,
    budget,
    execution: parseExecution(value.execution),
    thresholds: parseThresholds(value.thresholds),
  };
}

export function parsePilotFreeze(input: unknown): PilotFreeze {
  const value = recordValue(input, "pilot freeze");
  assertExactKeys(
    value,
    ["version", "status", "instructions", "files"],
    "pilot freeze",
  );
  if (value.version !== 1) {
    throw new Error("pilot freeze.version must be 1");
  }
  if (
    value.status !== "draft" &&
    value.status !== "frozen" &&
    value.status !== "completed"
  ) {
    throw new Error("pilot freeze.status must be draft, frozen, or completed");
  }
  const filesInput = recordValue(value.files, "pilot freeze.files");
  const files: Record<string, string> = {};
  for (const [file, hash] of Object.entries(filesInput)) {
    const path = relativePathValue(file, "pilot freeze file");
    if (path !== file) {
      throw new Error(`pilot freeze file must be normalized: ${file}`);
    }
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error(`pilot freeze hash is invalid: ${file}`);
    }
    files[file] = hash;
  }
  if (Object.keys(files).length === 0) {
    throw new Error("pilot freeze.files must not be empty");
  }
  return {
    version: 1,
    status: value.status,
    instructions: trimmedString(
      value.instructions,
      "pilot freeze.instructions",
    ),
    files,
  };
}

export function parsePilotReview(input: unknown): PilotReview {
  const value = recordValue(input, "pilot review");
  assertExactKeys(
    value,
    ["version", "status", "reviewer", "reviewedAt", "decisions", "cases"],
    "pilot review",
  );
  if (value.version !== 1) {
    throw new Error("pilot review.version must be 1");
  }
  if (value.status !== "draft" && value.status !== "approved") {
    throw new Error("pilot review.status must be draft or approved");
  }
  const reviewer = recordValue(value.reviewer, "pilot review.reviewer");
  assertExactKeys(
    reviewer,
    ["name", "role", "independentFromImplementation"],
    "pilot review.reviewer",
  );
  if (typeof reviewer.independentFromImplementation !== "boolean") {
    throw new Error(
      "pilot review.reviewer.independentFromImplementation must be a boolean",
    );
  }
  const decisions = recordValue(value.decisions, "pilot review.decisions");
  const decisionKeys = [
    "businessDefinitionsApproved",
    "baselinesApproved",
    "hiddenCasesApproved",
    "schemaChangesApproved",
    "syntheticDataOnly",
    "advisoryOnly",
    "budgetApproved",
    "stopAuthorityConfirmed",
    "goNoGoAuthorityConfirmed",
  ] as const;
  assertExactKeys(decisions, decisionKeys, "pilot review.decisions");
  for (const key of decisionKeys) {
    if (typeof decisions[key] !== "boolean") {
      throw new Error(`pilot review.decisions.${key} must be a boolean`);
    }
  }
  if (!Array.isArray(value.cases) || value.cases.length !== 8) {
    throw new Error("pilot review.cases must contain exactly 8 cases");
  }
  const cases = value.cases.map((entry, index) => {
    const path = `pilot review.cases[${index}]`;
    const reviewCase = recordValue(entry, path);
    assertExactKeys(reviewCase, ["caseId", "owner", "risk", "approved"], path);
    if (reviewCase.risk !== "low") {
      throw new Error(`${path}.risk must be low`);
    }
    if (typeof reviewCase.approved !== "boolean") {
      throw new Error(`${path}.approved must be a boolean`);
    }
    return {
      caseId: portableId(reviewCase.caseId, `${path}.caseId`),
      owner: trimmedString(reviewCase.owner, `${path}.owner`),
      risk: "low" as const,
      approved: reviewCase.approved,
    };
  });
  assertUnique(
    cases.map((entry) => entry.caseId),
    "pilot review case ids",
  );
  return {
    version: 1,
    status: value.status,
    reviewer: {
      name: nullableTrimmedString(reviewer.name, "pilot review.reviewer.name"),
      role: nullableTrimmedString(reviewer.role, "pilot review.reviewer.role"),
      independentFromImplementation: reviewer.independentFromImplementation,
    },
    reviewedAt: nullableTrimmedString(
      value.reviewedAt,
      "pilot review.reviewedAt",
    ),
    decisions: Object.fromEntries(
      decisionKeys.map((key) => [key, decisions[key]]),
    ) as PilotReview["decisions"],
    cases,
  };
}

export function assertPilotReviewApproved(
  review: PilotReview,
  manifest: PilotManifest,
): void {
  if (review.status !== "approved") {
    throw new Error("Pilot review must be approved before freezing inputs");
  }
  if (
    review.reviewer.name === null ||
    review.reviewer.role === null ||
    !review.reviewer.independentFromImplementation
  ) {
    throw new Error("Pilot review requires an identified independent reviewer");
  }
  if (
    review.reviewedAt === null ||
    !Number.isFinite(Date.parse(review.reviewedAt))
  ) {
    throw new Error("Pilot review requires a valid reviewedAt timestamp");
  }
  const failedDecision = Object.entries(review.decisions).find(
    ([, approved]) => !approved,
  );
  if (failedDecision !== undefined) {
    throw new Error(
      `Pilot review decision is not approved: ${failedDecision[0]}`,
    );
  }
  for (const pilotCase of manifest.cases) {
    const reviewed = review.cases.find(
      (entry) => entry.caseId === pilotCase.id,
    );
    if (
      reviewed === undefined ||
      !reviewed.approved ||
      reviewed.owner !== pilotCase.owner ||
      isPlaceholderIdentity(reviewed.owner)
    ) {
      throw new Error(
        `Pilot review case ${pilotCase.id} requires an approved real owner matching the manifest`,
      );
    }
  }
}

function parsePilotCase(input: unknown, index: number): PilotCase {
  const path = `pilot manifest.cases[${index}]`;
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "id",
      "domain",
      "source",
      "baseline",
      "hiddenCases",
      "schemaEvolutionSource",
      "fixture",
      "risk",
      "owner",
    ],
    path,
  );
  if (value.risk !== "low") {
    throw new Error(`${path}.risk must be low`);
  }
  return {
    id: portableId(value.id, `${path}.id`),
    domain: portableId(value.domain, `${path}.domain`),
    source: relativePathValue(value.source, `${path}.source`),
    baseline: relativePathValue(value.baseline, `${path}.baseline`),
    hiddenCases: relativePathValue(value.hiddenCases, `${path}.hiddenCases`),
    schemaEvolutionSource: relativePathValue(
      value.schemaEvolutionSource,
      `${path}.schemaEvolutionSource`,
    ),
    fixture: relativePathValue(value.fixture, `${path}.fixture`),
    risk: "low",
    owner: trimmedString(value.owner, `${path}.owner`),
  };
}

function parseBudget(input: unknown): PilotManifest["budget"] {
  const path = "pilot manifest.budget";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "maxApiCalls",
      "maxEstimatedCost",
      "maxWallClockMs",
      "maxResponseOutputTokens",
      "cooldownMsAfterEveryAttempt",
    ],
    path,
  );
  const cooldownMsAfterEveryAttempt = positiveInteger(
    value.cooldownMsAfterEveryAttempt,
    `${path}.cooldownMsAfterEveryAttempt`,
  );
  if (cooldownMsAfterEveryAttempt !== 60_000) {
    throw new Error(
      "pilot manifest.budget.cooldownMsAfterEveryAttempt must be 60000",
    );
  }
  return {
    maxApiCalls: positiveInteger(value.maxApiCalls, `${path}.maxApiCalls`),
    maxEstimatedCost: nonNegativeNumber(
      value.maxEstimatedCost,
      `${path}.maxEstimatedCost`,
    ),
    maxWallClockMs: positiveInteger(
      value.maxWallClockMs,
      `${path}.maxWallClockMs`,
    ),
    maxResponseOutputTokens: positiveInteger(
      value.maxResponseOutputTokens,
      `${path}.maxResponseOutputTokens`,
    ),
    cooldownMsAfterEveryAttempt: 60_000,
  };
}

function parseExecution(input: unknown): PilotManifest["execution"] {
  const path = "pilot manifest.execution";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    ["mode", "businessWritesAllowed", "externalIoAllowed"],
    path,
  );
  if (
    value.mode !== "shadow" ||
    value.businessWritesAllowed !== false ||
    value.externalIoAllowed !== false
  ) {
    throw new Error(
      "pilot execution must be shadow-only with business writes and external I/O disabled",
    );
  }
  return {
    mode: "shadow",
    businessWritesAllowed: false,
    externalIoAllowed: false,
  };
}

function parseThresholds(input: unknown): PilotManifest["thresholds"] {
  const path = "pilot manifest.thresholds";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    ["minFirstPassProjectFitRate", "maxUnresolvedRate", "maxFalseResolutions"],
    path,
  );
  if (value.maxFalseResolutions !== 0) {
    throw new Error(`${path}.maxFalseResolutions must be 0`);
  }
  return {
    minFirstPassProjectFitRate: unitInterval(
      value.minFirstPassProjectFitRate,
      `${path}.minFirstPassProjectFitRate`,
    ),
    maxUnresolvedRate: unitInterval(
      value.maxUnresolvedRate,
      `${path}.maxUnresolvedRate`,
    ),
    maxFalseResolutions: 0,
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

function nullableTrimmedString(input: unknown, path: string): string | null {
  return input === null ? null : trimmedString(input, path);
}

function isPlaceholderIdentity(value: string): boolean {
  return /^(?:pending|private-pilot-owner|tbd|todo)$/iu.test(value);
}

function portableId(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`${path} must be a portable identifier`);
  }
  return value;
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

function pathArray(
  input: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string[] {
  if (
    !Array.isArray(input) ||
    input.length < minimum ||
    input.length > maximum
  ) {
    throw new Error(
      `${path} must contain between ${minimum} and ${maximum} items`,
    );
  }
  return input.map((value, index) =>
    relativePathValue(value, `${path}[${index}]`),
  );
}

function stringArray(
  input: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string[] {
  if (
    !Array.isArray(input) ||
    input.length < minimum ||
    input.length > maximum
  ) {
    throw new Error(
      `${path} must contain between ${minimum} and ${maximum} items`,
    );
  }
  return input.map((value, index) => portableId(value, `${path}[${index}]`));
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
}

function positiveInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || Number(input) <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return Number(input);
}

function nonNegativeNumber(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
  return input;
}

function unitInterval(input: unknown, path: string): number {
  const value = nonNegativeNumber(input, path);
  if (value > 1) {
    throw new Error(`${path} must be between 0 and 1`);
  }
  return value;
}
