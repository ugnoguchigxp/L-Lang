import { isIP } from "node:net";
import { resolve } from "node:path";
import {
  DEFAULT_EFFECTS_LIMITS,
  type BudgetLimits,
} from "./llang-effects-contract";
import type { ParsedEffectsExecutionGrant } from "./llang-effects-execution-grant";
import {
  decodeUtf8,
  LLANG_SOURCE_BYTES,
  parseStrictJsonObject,
} from "./llang-jsonc";
import type { CheckedEffectsGraph } from "./llang-module-effects-graph";
import { fingerprintFor, sha256 } from "./stable-hash";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const OPERATION = /^[a-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)*@[1-9][0-9]*$/;
const HEADER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const STATUSES = ["cancelled", "completed", "failed", "incomplete"] as const;
const LEVELS = ["must", "must-not", "should"] as const;
const VERIFICATIONS = ["authority", "manual", "outcome", "structure"] as const;
const LIMIT_NAMES = Object.keys(
  DEFAULT_EFFECTS_LIMITS,
) as (keyof BudgetLimits)[];

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const sortedUnique = (values: readonly string[]) =>
  values.length === new Set(values).size &&
  values.join("\0") === [...values].sort().join("\0");
const stringArray = (value: unknown, pattern?: RegExp): value is string[] =>
  Array.isArray(value) &&
  value.every(
    (item) => typeof item === "string" && (!pattern || pattern.test(item)),
  ) &&
  sortedUnique(value);
const logicalRoot = (value: string) =>
  !!value &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const networkEntry = (value: string) => {
  const slash = value.lastIndexOf("/"),
    address = slash < 0 ? value : value.slice(0, slash),
    family = isIP(address);
  if (!family) return false;
  if (slash < 0) return true;
  const prefix = Number(value.slice(slash + 1));
  return (
    Number.isInteger(prefix) &&
    prefix >= 0 &&
    prefix <= (family === 4 ? 32 : 128)
  );
};

export type EffectsRequirementDocument = Readonly<{
  format: "llang-effects-requirements";
  version: 1;
  id: string;
  revision: number;
  body: string;
  bundleIdentityHash: string;
  requirements: readonly Readonly<{
    id: string;
    level: (typeof LEVELS)[number];
    statement: string;
    verification: (typeof VERIFICATIONS)[number];
  }>[];
  bindings: readonly Readonly<{
    requirementId: string;
    nodes: readonly number[];
    operations: readonly string[];
    authorityRules: readonly string[];
    terminalStatuses: readonly (typeof STATUSES)[number][];
  }>[];
  authorityCeiling: Readonly<{
    operations: readonly string[];
    file: null | Readonly<{
      logicalRoots: readonly string[];
      read: boolean;
      write: boolean;
      replace: boolean;
    }>;
    http: null | Readonly<{
      origins: readonly string[];
      methods: readonly string[];
      requestHeaders: readonly string[];
      allowPublic: boolean;
      allowedAddresses: readonly string[];
    }>;
    wallClock: boolean;
    deadlineMs: number;
    limits: Readonly<Partial<BudgetLimits>>;
  }>;
  expectedTerminalStatuses: readonly (typeof STATUSES)[number][];
}>;

export type ParsedEffectsRequirementContract = Readonly<{
  path: string;
  fileIdentity: Readonly<{ dev: number; ino: number }>;
  sourceHash: string;
  commitmentHash: string;
  authorityCommitmentHash: string;
  document: EffectsRequirementDocument;
  coverage: Readonly<{
    total: number;
    authority: number;
    structure: number;
    outcome: number;
    manual: number;
    reviewRequired: number;
  }>;
}>;

function parseLimits(value: unknown): Readonly<Partial<BudgetLimits>> {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !LIMIT_NAMES.includes(key as keyof BudgetLimits),
    )
  )
    throw new Error("INVALID_EFFECTS_REQUIREMENT_LIMITS");
  const result: Partial<Record<keyof BudgetLimits, number>> = {};
  for (const [name, raw] of Object.entries(value)) {
    const key = name as keyof BudgetLimits;
    if (
      !Number.isSafeInteger(raw) ||
      Number(raw) < 0 ||
      Number(raw) > DEFAULT_EFFECTS_LIMITS[key]
    )
      throw new Error(`INVALID_EFFECTS_REQUIREMENT_LIMIT: ${name}`);
    result[key] = Number(raw);
  }
  return Object.freeze(result);
}

function parseAuthority(
  value: unknown,
): EffectsRequirementDocument["authorityCeiling"] {
  if (
    !object(value) ||
    !exact(value, [
      "operations",
      "file",
      "http",
      "wallClock",
      "deadlineMs",
      "limits",
    ]) ||
    !stringArray(value.operations, OPERATION) ||
    typeof value.wallClock !== "boolean" ||
    !Number.isSafeInteger(value.deadlineMs) ||
    Number(value.deadlineMs) < 1 ||
    Number(value.deadlineMs) > 86_400_000
  )
    throw new Error("INVALID_EFFECTS_REQUIREMENT_AUTHORITY");
  if (
    value.file !== null &&
    (!object(value.file) ||
      !exact(value.file, ["logicalRoots", "read", "write", "replace"]) ||
      !stringArray(value.file.logicalRoots) ||
      !value.file.logicalRoots.every(logicalRoot) ||
      typeof value.file.read !== "boolean" ||
      typeof value.file.write !== "boolean" ||
      typeof value.file.replace !== "boolean" ||
      (value.file.replace && !value.file.write))
  )
    throw new Error("INVALID_EFFECTS_REQUIREMENT_FILE_AUTHORITY");
  if (value.http !== null) {
    if (
      !object(value.http) ||
      !exact(value.http, [
        "origins",
        "methods",
        "requestHeaders",
        "allowPublic",
        "allowedAddresses",
      ]) ||
      !stringArray(value.http.origins) ||
      !value.http.origins.every((origin) => {
        try {
          const parsed = new URL(origin);
          return (
            parsed.origin === origin &&
            !parsed.username &&
            !parsed.password &&
            ["http:", "https:"].includes(parsed.protocol)
          );
        } catch {
          return false;
        }
      }) ||
      !stringArray(value.http.methods) ||
      !value.http.methods.every((method) => METHODS.has(method)) ||
      !stringArray(value.http.requestHeaders) ||
      !value.http.requestHeaders.every(
        (header) => header === header.toLowerCase() && HEADER.test(header),
      ) ||
      typeof value.http.allowPublic !== "boolean" ||
      !stringArray(value.http.allowedAddresses) ||
      !value.http.allowedAddresses.every(networkEntry)
    )
      throw new Error("INVALID_EFFECTS_REQUIREMENT_HTTP_AUTHORITY");
  }
  return Object.freeze({
    operations: Object.freeze([...(value.operations as string[])]),
    file:
      value.file === null
        ? null
        : Object.freeze({
            logicalRoots: Object.freeze([
              ...(value.file.logicalRoots as string[]),
            ]),
            read: value.file.read as boolean,
            write: value.file.write as boolean,
            replace: value.file.replace as boolean,
          }),
    http:
      value.http === null
        ? null
        : Object.freeze({
            origins: Object.freeze([...(value.http.origins as string[])]),
            methods: Object.freeze([...(value.http.methods as string[])]),
            requestHeaders: Object.freeze([
              ...(value.http.requestHeaders as string[]),
            ]),
            allowPublic: value.http.allowPublic as boolean,
            allowedAddresses: Object.freeze([
              ...(value.http.allowedAddresses as string[]),
            ]),
          }),
    wallClock: value.wallClock,
    deadlineMs: Number(value.deadlineMs),
    limits: parseLimits(value.limits),
  });
}

export function parseEffectsRequirementDocument(
  value: unknown,
): EffectsRequirementDocument {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "id",
      "revision",
      "body",
      "bundleIdentityHash",
      "requirements",
      "bindings",
      "authorityCeiling",
      "expectedTerminalStatuses",
    ]) ||
    value.format !== "llang-effects-requirements" ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.body !== "string" ||
    !value.body.trim() ||
    value.body.length > 16_384 ||
    !HASH.test(String(value.bundleIdentityHash)) ||
    !Array.isArray(value.requirements) ||
    value.requirements.length === 0 ||
    !Array.isArray(value.bindings) ||
    !stringArray(value.expectedTerminalStatuses) ||
    !value.expectedTerminalStatuses.every((status) =>
      STATUSES.includes(status as (typeof STATUSES)[number]),
    ) ||
    value.expectedTerminalStatuses.length === 0
  )
    throw new Error("INVALID_EFFECTS_REQUIREMENT_DOCUMENT");
  const requirements = value.requirements.map((raw) => {
    if (
      !object(raw) ||
      !exact(raw, ["id", "level", "statement", "verification"]) ||
      typeof raw.id !== "string" ||
      !ID.test(raw.id) ||
      !LEVELS.includes(raw.level as (typeof LEVELS)[number]) ||
      typeof raw.statement !== "string" ||
      !raw.statement.trim() ||
      raw.statement.length > 8_192 ||
      !VERIFICATIONS.includes(
        raw.verification as (typeof VERIFICATIONS)[number],
      )
    )
      throw new Error("INVALID_EFFECTS_REQUIREMENT");
    return Object.freeze({
      id: raw.id as string,
      level: raw.level as (typeof LEVELS)[number],
      statement: raw.statement as string,
      verification: raw.verification as (typeof VERIFICATIONS)[number],
    });
  });
  if (!sortedUnique(requirements.map((item) => item.id)))
    throw new Error("INVALID_EFFECTS_REQUIREMENT_ORDER");
  const bindings = value.bindings.map((raw) => {
    if (
      !object(raw) ||
      !exact(raw, [
        "requirementId",
        "nodes",
        "operations",
        "authorityRules",
        "terminalStatuses",
      ]) ||
      typeof raw.requirementId !== "string" ||
      !ID.test(raw.requirementId) ||
      !Array.isArray(raw.nodes) ||
      !raw.nodes.every(
        (node) => Number.isSafeInteger(node) && Number(node) >= 0,
      ) ||
      raw.nodes.length !== new Set(raw.nodes).size ||
      raw.nodes.join() !==
        [...raw.nodes].sort((a, b) => Number(a) - Number(b)).join() ||
      !stringArray(raw.operations, OPERATION) ||
      !stringArray(raw.authorityRules) ||
      !stringArray(raw.terminalStatuses) ||
      !raw.terminalStatuses.every((status) =>
        STATUSES.includes(status as (typeof STATUSES)[number]),
      )
    )
      throw new Error("INVALID_EFFECTS_REQUIREMENT_BINDING");
    return Object.freeze({
      requirementId: raw.requirementId as string,
      nodes: Object.freeze([...(raw.nodes as number[])]),
      operations: Object.freeze([...(raw.operations as string[])]),
      authorityRules: Object.freeze([...(raw.authorityRules as string[])]),
      terminalStatuses: Object.freeze([
        ...(raw.terminalStatuses as (typeof STATUSES)[number][]),
      ]),
    });
  });
  if (!sortedUnique(bindings.map((item) => item.requirementId)))
    throw new Error("INVALID_EFFECTS_REQUIREMENT_BINDING_ORDER");
  return Object.freeze({
    format: "llang-effects-requirements",
    version: 1,
    id: value.id,
    revision: Number(value.revision),
    body: value.body,
    bundleIdentityHash: String(value.bundleIdentityHash),
    requirements: Object.freeze(requirements),
    bindings: Object.freeze(bindings),
    authorityCeiling: parseAuthority(value.authorityCeiling),
    expectedTerminalStatuses: Object.freeze([
      ...(value.expectedTerminalStatuses as (typeof STATUSES)[number][]),
    ]),
  });
}

function validateBindings(
  document: EffectsRequirementDocument,
  graph: CheckedEffectsGraph,
) {
  const requirementById = new Map(
      document.requirements.map((item) => [item.id, item]),
    ),
    operationSet = new Set(
      graph.manifest.operations.map((item) => `${item.id}@${item.version}`),
    ),
    allowedAuthorityRules = new Set(["deadline", "file", "http", "wall-clock"]);
  for (const name of LIMIT_NAMES) allowedAuthorityRules.add(`limit/${name}`);
  if (
    document.authorityCeiling.operations.join() !==
    [...operationSet].sort().join()
  )
    throw new Error("EFFECTS_REQUIREMENT_OPERATION_MISMATCH");
  const bindingById = new Map(
    document.bindings.map((binding) => [binding.requirementId, binding]),
  );
  for (const binding of document.bindings) {
    const requirement = requirementById.get(binding.requirementId);
    if (
      !requirement ||
      binding.nodes.some((node) => node >= graph.program.nodes.length) ||
      binding.operations.some((operation) => !operationSet.has(operation)) ||
      binding.authorityRules.some((rule) => !allowedAuthorityRules.has(rule)) ||
      (binding.authorityRules.includes("file") &&
        document.authorityCeiling.file === null) ||
      (binding.authorityRules.includes("http") &&
        document.authorityCeiling.http === null) ||
      (binding.authorityRules.includes("wall-clock") &&
        !document.authorityCeiling.wallClock)
    )
      throw new Error("EFFECTS_REQUIREMENT_BINDING_MISMATCH");
    if (
      (requirement.verification === "authority" &&
        binding.authorityRules.length === 0) ||
      (requirement.verification === "structure" &&
        binding.nodes.length + binding.operations.length === 0) ||
      (requirement.verification === "outcome" &&
        binding.terminalStatuses.length === 0)
    )
      throw new Error("EFFECTS_REQUIREMENT_BINDING_INCOMPLETE");
  }
  for (const requirement of document.requirements)
    if (
      requirement.verification !== "manual" &&
      !bindingById.has(requirement.id)
    )
      throw new Error("EFFECTS_REQUIREMENT_BINDING_MISSING");
}

export async function readEffectsRequirementContract(
  path: string,
  bundleIdentityHash: string,
  graph: CheckedEffectsGraph,
): Promise<ParsedEffectsRequirementContract> {
  const absolute = resolve(path),
    snapshot = await readStableRegularFileSnapshot(
      absolute,
      LLANG_SOURCE_BYTES,
      "INVALID_EFFECTS_REQUIREMENT_FILE",
    ),
    document = parseEffectsRequirementDocument(
      parseStrictJsonObject(decodeUtf8(snapshot.bytes, absolute), absolute),
    );
  if (document.bundleIdentityHash !== bundleIdentityHash)
    throw new Error("EFFECTS_REQUIREMENT_BUNDLE_MISMATCH");
  validateBindings(document, graph);
  const counts = (verification: (typeof VERIFICATIONS)[number]) =>
    document.requirements.filter((item) => item.verification === verification)
      .length;
  return Object.freeze({
    path: absolute,
    fileIdentity: Object.freeze({ dev: snapshot.dev, ino: snapshot.ino }),
    sourceHash: sha256(snapshot.bytes),
    commitmentHash: fingerprintFor(document),
    authorityCommitmentHash: fingerprintFor(document.authorityCeiling),
    document,
    coverage: Object.freeze({
      total: document.requirements.length,
      authority: counts("authority"),
      structure: counts("structure"),
      outcome: counts("outcome"),
      manual: counts("manual"),
      reviewRequired: document.requirements.filter(
        (item) => item.verification === "manual" && item.level !== "should",
      ).length,
    }),
  });
}

const subset = (actual: readonly string[], ceiling: readonly string[]) =>
  actual.every((item) => ceiling.includes(item));
const pathWithin = (candidate: string, root: string) =>
  candidate === root || candidate.startsWith(`${root}/`);

export function assertGrantWithinRequirement(
  grant: ParsedEffectsExecutionGrant,
  requirements: ParsedEffectsRequirementContract,
): void {
  assertAuthorityWithinRequirement(grant.document, grant.limits, requirements);
}

function assertAuthorityWithinRequirement(
  actual: Readonly<{
    operations: readonly string[];
    file: EffectsRequirementDocument["authorityCeiling"]["file"];
    http: EffectsRequirementDocument["authorityCeiling"]["http"];
    wallClock: boolean;
    deadlineMs: number;
  }>,
  limits: BudgetLimits,
  requirements: ParsedEffectsRequirementContract,
): void {
  const ceiling = requirements.document.authorityCeiling;
  if (
    !subset(actual.operations, ceiling.operations) ||
    actual.deadlineMs > ceiling.deadlineMs ||
    (actual.wallClock && !ceiling.wallClock)
  )
    throw new Error("EFFECTS_GRANT_EXCEEDS_REQUIREMENT_AUTHORITY");
  if (actual.file) {
    if (
      !ceiling.file ||
      (actual.file.read && !ceiling.file.read) ||
      (actual.file.write && !ceiling.file.write) ||
      (actual.file.replace && !ceiling.file.replace) ||
      actual.file.logicalRoots.some(
        (root) =>
          !ceiling.file?.logicalRoots.some((allowed) =>
            pathWithin(root, allowed),
          ),
      )
    )
      throw new Error("EFFECTS_GRANT_EXCEEDS_REQUIREMENT_FILE_AUTHORITY");
  }
  if (actual.http) {
    if (
      !ceiling.http ||
      !subset(actual.http.origins, ceiling.http.origins) ||
      !subset(actual.http.methods, ceiling.http.methods) ||
      !subset(actual.http.requestHeaders, ceiling.http.requestHeaders) ||
      (actual.http.allowPublic && !ceiling.http.allowPublic) ||
      !subset(actual.http.allowedAddresses, ceiling.http.allowedAddresses)
    )
      throw new Error("EFFECTS_GRANT_EXCEEDS_REQUIREMENT_HTTP_AUTHORITY");
  }
  const ceilingLimits = { ...DEFAULT_EFFECTS_LIMITS, ...ceiling.limits };
  for (const name of LIMIT_NAMES)
    if (limits[name] > ceilingLimits[name])
      throw new Error(`EFFECTS_GRANT_EXCEEDS_REQUIREMENT_LIMIT: ${name}`);
}

function parseGrantSummary(value: unknown) {
  if (
    !object(value) ||
    !exact(value, [
      "operations",
      "file",
      "http",
      "wallClock",
      "deadlineMs",
      "limits",
    ]) ||
    !stringArray(value.operations, OPERATION) ||
    typeof value.wallClock !== "boolean" ||
    !Number.isSafeInteger(value.deadlineMs) ||
    !object(value.limits)
  )
    throw new Error("INVALID_EFFECTS_GRANT_SUMMARY");
  const rawLimits = value.limits as Record<string, unknown>;
  if (
    Object.keys(rawLimits).length !== LIMIT_NAMES.length ||
    Object.keys(rawLimits).some(
      (name) => !LIMIT_NAMES.includes(name as keyof BudgetLimits),
    )
  )
    throw new Error("INVALID_EFFECTS_GRANT_SUMMARY");
  const limits = Object.fromEntries(
    LIMIT_NAMES.map((name) => {
      const raw = rawLimits[name];
      if (
        !Number.isSafeInteger(raw) ||
        Number(raw) < 0 ||
        Number(raw) > DEFAULT_EFFECTS_LIMITS[name]
      )
        throw new Error("INVALID_EFFECTS_GRANT_SUMMARY");
      return [name, Number(raw)];
    }),
  ) as BudgetLimits;
  const authority = parseAuthority({
    operations: value.operations,
    file: value.file,
    http: value.http,
    wallClock: value.wallClock,
    deadlineMs: value.deadlineMs,
    limits: {},
  });
  return Object.freeze({ authority, limits });
}

export function assertEffectsGrantSummaryShape(value: unknown): void {
  parseGrantSummary(value);
}

export function assertGrantSummaryWithinRequirement(
  value: unknown,
  requirements: ParsedEffectsRequirementContract,
): void {
  const { authority, limits } = parseGrantSummary(value);
  assertAuthorityWithinRequirement(authority, limits, requirements);
}

export async function assertEffectsRequirementIdentity(
  requirements: ParsedEffectsRequirementContract,
  bundleIdentityHash: string,
  graph: CheckedEffectsGraph,
): Promise<void> {
  const current = await readEffectsRequirementContract(
    requirements.path,
    bundleIdentityHash,
    graph,
  );
  if (
    current.fileIdentity.dev !== requirements.fileIdentity.dev ||
    current.fileIdentity.ino !== requirements.fileIdentity.ino ||
    current.sourceHash !== requirements.sourceHash ||
    current.commitmentHash !== requirements.commitmentHash
  )
    throw new Error("EFFECTS_REQUIREMENTS_CHANGED");
}
