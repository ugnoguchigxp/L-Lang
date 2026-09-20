import { resolve } from "node:path";
import type { EffectValueType, TypedEffectNode } from "./llang-effects-ir";
import type { CheckedEffectsGraph } from "./llang-module-effects-graph";
import type { ParsedEffectsRequirementContract } from "./llang-effects-requirement-contract";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { fingerprintFor, sha256 } from "./stable-hash";
import type { EffectsTranscriptEvent } from "./llang-effects-transcript-writer";

const ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const OPERATION = /^[a-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)*@[1-9][0-9]*$/;
const FIELD = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_BYTES = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const sortedUnique = (values: readonly string[]) =>
  values.length === new Set(values).size &&
  values.join("\0") === [...values].sort().join("\0");

export type EffectsTrustBoundaryDocument = Readonly<{
  format: "llang-effects-trust-boundary";
  version: 1;
  id: string;
  revision: number;
  requirements: Readonly<{
    id: string;
    revision: number;
    commitmentHash: string;
  }>;
  sources: readonly Readonly<{
    id: string;
    operation: string;
    responsePath: readonly string[];
    classification: "untrusted-data";
  }>[];
  sinks: readonly Readonly<{
    id: string;
    operation: string;
    requestPath: readonly string[];
    classification: "external-output";
  }>[];
  allowedFlows: readonly Readonly<{
    source: string;
    sink: string;
    purpose: string;
  }>[];
  rules: Readonly<{
    denyUnlistedFlows: true;
    denyDataDerivedAuthority: true;
    rawExternalDataInAudit: false;
  }>;
}>;

export type EffectsStaticProvenance = Readonly<{
  format: "llang-effects-static-provenance";
  version: 1;
  boundaryCommitmentHash: string;
  programHash: string;
  authorityDerivation: "static-not-data-derived";
  sources: readonly Readonly<{
    id: string;
    operation: string;
    nodeIndexes: readonly number[];
  }>[];
  sinks: readonly Readonly<{
    id: string;
    operation: string;
    nodeIndexes: readonly number[];
  }>[];
  flows: readonly Readonly<{
    source: string;
    sink: string;
    purpose: string;
    sourceNodeIndexes: readonly number[];
    sinkNodeIndexes: readonly number[];
  }>[];
  unlistedFlows: readonly string[];
}>;

export type ParsedEffectsTrustBoundary = Readonly<{
  path: string;
  fileIdentity: Readonly<{ dev: number; ino: number }>;
  sourceHash: string;
  commitmentHash: string;
  document: EffectsTrustBoundaryDocument;
  provenance: EffectsStaticProvenance;
  provenanceHash: string;
}>;

const hash = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new Error("INVALID_EFFECTS_STATIC_PROVENANCE");
  return value;
};

const nodeIndexes = (value: unknown): readonly number[] => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 256 ||
    !value.every(
      (index) => Number.isSafeInteger(index) && Number(index) >= 0,
    ) ||
    value.join("\0") !== [...new Set(value)].sort((a, b) => a - b).join("\0")
  )
    throw new Error("INVALID_EFFECTS_STATIC_PROVENANCE");
  return Object.freeze(value.map(Number));
};

export function parseEffectsStaticProvenance(
  value: unknown,
): EffectsStaticProvenance {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "boundaryCommitmentHash",
      "programHash",
      "authorityDerivation",
      "sources",
      "sinks",
      "flows",
      "unlistedFlows",
    ]) ||
    value.format !== "llang-effects-static-provenance" ||
    value.version !== 1 ||
    value.authorityDerivation !== "static-not-data-derived" ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.sinks) ||
    !Array.isArray(value.flows) ||
    !Array.isArray(value.unlistedFlows) ||
    value.sources.length > 256 ||
    value.sinks.length > 256 ||
    value.flows.length > 1024 ||
    value.unlistedFlows.length > 1024
  )
    throw new Error("INVALID_EFFECTS_STATIC_PROVENANCE");
  const parseEndpoint = (raw: unknown) => {
      if (
        !object(raw) ||
        !exact(raw, ["id", "operation", "nodeIndexes"]) ||
        typeof raw.id !== "string" ||
        !ID.test(raw.id) ||
        typeof raw.operation !== "string" ||
        !OPERATION.test(raw.operation)
      )
        throw new Error("INVALID_EFFECTS_STATIC_PROVENANCE");
      return Object.freeze({
        id: raw.id,
        operation: raw.operation,
        nodeIndexes: nodeIndexes(raw.nodeIndexes),
      });
    },
    sources = value.sources.map(parseEndpoint),
    sinks = value.sinks.map(parseEndpoint),
    flows = value.flows.map((raw) => {
      if (
        !object(raw) ||
        !exact(raw, [
          "source",
          "sink",
          "purpose",
          "sourceNodeIndexes",
          "sinkNodeIndexes",
        ]) ||
        typeof raw.source !== "string" ||
        !ID.test(raw.source) ||
        typeof raw.sink !== "string" ||
        !ID.test(raw.sink) ||
        typeof raw.purpose !== "string" ||
        !ID.test(raw.purpose)
      )
        throw new Error("INVALID_EFFECTS_STATIC_PROVENANCE");
      return Object.freeze({
        source: raw.source,
        sink: raw.sink,
        purpose: raw.purpose,
        sourceNodeIndexes: nodeIndexes(raw.sourceNodeIndexes),
        sinkNodeIndexes: nodeIndexes(raw.sinkNodeIndexes),
      });
    }),
    sourceIds = new Set(sources.map(({ id }) => id)),
    sinkIds = new Set(sinks.map(({ id }) => id)),
    unlistedFlows = value.unlistedFlows.map((item) => {
      if (
        typeof item !== "string" ||
        !/^[a-z0-9._/-]+->[a-z0-9._/-]+$/.test(item)
      )
        throw new Error("INVALID_EFFECTS_STATIC_PROVENANCE");
      return item;
    });
  if (
    !sortedUnique(sources.map(({ id }) => id)) ||
    !sortedUnique(sinks.map(({ id }) => id)) ||
    !sortedUnique(
      flows.map(
        ({ source, sink, purpose }) => `${source}\0${sink}\0${purpose}`,
      ),
    ) ||
    !sortedUnique(unlistedFlows) ||
    flows.some(
      ({ source, sink }) => !sourceIds.has(source) || !sinkIds.has(sink),
    )
  )
    throw new Error("INVALID_EFFECTS_STATIC_PROVENANCE");
  return Object.freeze({
    format: "llang-effects-static-provenance",
    version: 1,
    boundaryCommitmentHash: hash(value.boundaryCommitmentHash),
    programHash: hash(value.programHash),
    authorityDerivation: "static-not-data-derived",
    sources: Object.freeze(sources),
    sinks: Object.freeze(sinks),
    flows: Object.freeze(flows),
    unlistedFlows: Object.freeze(unlistedFlows),
  });
}

function path(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    !value.every((part) => typeof part === "string" && FIELD.test(part))
  )
    throw new Error("INVALID_EFFECTS_TRUST_BOUNDARY_PATH");
  return Object.freeze([...value]);
}

function hasTypePath(type: EffectValueType, parts: readonly string[]): boolean {
  let current = type;
  for (const part of parts) {
    if (current.kind !== "record" || !current.fields[part]) return false;
    current = current.fields[part];
  }
  return true;
}

function flattenedNodes(graph: CheckedEffectsGraph) {
  return graph.program.nodes.flatMap((node, nodeIndex) =>
    node.kind === "task"
      ? node.tasks.map((task) => ({ node: task, nodeIndex }))
      : [{ node, nodeIndex }],
  );
}

function operationKey(
  node: TypedEffectNode | Extract<TypedEffectNode, { kind: "await" }>,
) {
  if (node.kind === "task") throw new Error("INVALID_EFFECTS_TRUST_BOUNDARY");
  return `${node.operation}@${node.version}`;
}

export function parseEffectsTrustBoundary(
  value: unknown,
): EffectsTrustBoundaryDocument {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "id",
      "revision",
      "requirements",
      "sources",
      "sinks",
      "allowedFlows",
      "rules",
    ]) ||
    value.format !== "llang-effects-trust-boundary" ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !object(value.requirements) ||
    !exact(value.requirements, ["id", "revision", "commitmentHash"]) ||
    typeof value.requirements.id !== "string" ||
    !ID.test(value.requirements.id) ||
    !Number.isSafeInteger(value.requirements.revision) ||
    Number(value.requirements.revision) < 1 ||
    !/^[0-9a-f]{64}$/.test(String(value.requirements.commitmentHash)) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.sinks) ||
    !Array.isArray(value.allowedFlows) ||
    value.sources.length > 256 ||
    value.sinks.length > 256 ||
    value.allowedFlows.length > 1024 ||
    !object(value.rules) ||
    !exact(value.rules, [
      "denyUnlistedFlows",
      "denyDataDerivedAuthority",
      "rawExternalDataInAudit",
    ]) ||
    value.rules.denyUnlistedFlows !== true ||
    value.rules.denyDataDerivedAuthority !== true ||
    value.rules.rawExternalDataInAudit !== false
  )
    throw new Error("INVALID_EFFECTS_TRUST_BOUNDARY");
  const sources = value.sources.map((raw) => {
      if (
        !object(raw) ||
        !exact(raw, ["id", "operation", "responsePath", "classification"]) ||
        typeof raw.id !== "string" ||
        !ID.test(raw.id) ||
        typeof raw.operation !== "string" ||
        !OPERATION.test(raw.operation) ||
        raw.classification !== "untrusted-data"
      )
        throw new Error("INVALID_EFFECTS_TRUST_BOUNDARY_SOURCE");
      return Object.freeze({
        id: raw.id,
        operation: raw.operation,
        responsePath: path(raw.responsePath),
        classification: "untrusted-data" as const,
      });
    }),
    sinks = value.sinks.map((raw) => {
      if (
        !object(raw) ||
        !exact(raw, ["id", "operation", "requestPath", "classification"]) ||
        typeof raw.id !== "string" ||
        !ID.test(raw.id) ||
        typeof raw.operation !== "string" ||
        !OPERATION.test(raw.operation) ||
        raw.classification !== "external-output"
      )
        throw new Error("INVALID_EFFECTS_TRUST_BOUNDARY_SINK");
      return Object.freeze({
        id: raw.id,
        operation: raw.operation,
        requestPath: path(raw.requestPath),
        classification: "external-output" as const,
      });
    }),
    sourceIds = sources.map(({ id }) => id),
    sinkIds = sinks.map(({ id }) => id);
  if (!sortedUnique(sourceIds) || !sortedUnique(sinkIds))
    throw new Error("INVALID_EFFECTS_TRUST_BOUNDARY_ORDER");
  const sourceSet = new Set(sourceIds),
    sinkSet = new Set(sinkIds),
    flows = value.allowedFlows.map((raw) => {
      if (
        !object(raw) ||
        !exact(raw, ["source", "sink", "purpose"]) ||
        typeof raw.source !== "string" ||
        !sourceSet.has(raw.source) ||
        typeof raw.sink !== "string" ||
        !sinkSet.has(raw.sink) ||
        typeof raw.purpose !== "string" ||
        !ID.test(raw.purpose)
      )
        throw new Error("INVALID_EFFECTS_TRUST_BOUNDARY_FLOW");
      return Object.freeze({
        source: raw.source,
        sink: raw.sink,
        purpose: raw.purpose,
      });
    }),
    flowKeys = flows.map(
      ({ source, sink, purpose }) => `${source}\0${sink}\0${purpose}`,
    );
  if (!sortedUnique(flowKeys))
    throw new Error("INVALID_EFFECTS_TRUST_BOUNDARY_ORDER");
  return Object.freeze({
    format: "llang-effects-trust-boundary",
    version: 1,
    id: value.id,
    revision: Number(value.revision),
    requirements: Object.freeze({
      id: value.requirements.id,
      revision: Number(value.requirements.revision),
      commitmentHash: String(value.requirements.commitmentHash),
    }),
    sources: Object.freeze(sources),
    sinks: Object.freeze(sinks),
    allowedFlows: Object.freeze(flows),
    rules: Object.freeze({
      denyUnlistedFlows: true,
      denyDataDerivedAuthority: true,
      rawExternalDataInAudit: false,
    }),
  });
}

export function analyzeEffectsProvenance(
  document: EffectsTrustBoundaryDocument,
  graph: CheckedEffectsGraph,
): EffectsStaticProvenance {
  const nodes = flattenedNodes(graph),
    operations = [
      ...new Set(nodes.map(({ node }) => operationKey(node))),
    ].sort(),
    declaredSources = [
      ...new Set(document.sources.map(({ operation }) => operation)),
    ].sort(),
    declaredSinks = [
      ...new Set(document.sinks.map(({ operation }) => operation)),
    ].sort();
  if (operations.join("\0") !== declaredSources.join("\0"))
    throw new Error("EFFECTS_TRUST_BOUNDARY_SOURCE_COVERAGE");
  if (operations.join("\0") !== declaredSinks.join("\0"))
    throw new Error("EFFECTS_TRUST_BOUNDARY_SINK_COVERAGE");
  const sourceResults = document.sources.map((source) => {
      const matches = nodes.filter(
        ({ node }) => operationKey(node) === source.operation,
      );
      if (
        !matches.length ||
        matches.some(
          ({ node }) => !hasTypePath(node.responseType, source.responsePath),
        )
      )
        throw new Error("EFFECTS_TRUST_BOUNDARY_SOURCE_NOT_FOUND");
      return Object.freeze({
        id: source.id,
        operation: source.operation,
        nodeIndexes: Object.freeze([
          ...new Set(matches.map(({ nodeIndex }) => nodeIndex)),
        ]),
      });
    }),
    sinkResults = document.sinks.map((sink) => {
      const matches = nodes.filter(
        ({ node }) => operationKey(node) === sink.operation,
      );
      if (
        !matches.length ||
        matches.some(
          ({ node }) => !hasTypePath(node.requestType, sink.requestPath),
        )
      )
        throw new Error("EFFECTS_TRUST_BOUNDARY_SINK_NOT_FOUND");
      return Object.freeze({
        id: sink.id,
        operation: sink.operation,
        nodeIndexes: Object.freeze([
          ...new Set(matches.map(({ nodeIndex }) => nodeIndex)),
        ]),
      });
    }),
    sources = new Map(sourceResults.map((item) => [item.id, item])),
    sinks = new Map(sinkResults.map((item) => [item.id, item])),
    flows = document.allowedFlows.map((flow) => {
      const source = sources.get(flow.source),
        sink = sinks.get(flow.sink);
      if (!source || !sink)
        throw new Error("INVALID_EFFECTS_TRUST_BOUNDARY_FLOW");
      return Object.freeze({
        ...flow,
        sourceNodeIndexes: source.nodeIndexes,
        sinkNodeIndexes: sink.nodeIndexes,
      });
    }),
    allowedPairs = new Set(
      document.allowedFlows.map(({ source, sink }) => `${source}\0${sink}`),
    ),
    unlistedFlows = sourceResults.flatMap((source) =>
      sinkResults
        .filter((sink) =>
          source.nodeIndexes.some((sourceIndex) =>
            sink.nodeIndexes.some((sinkIndex) => sourceIndex <= sinkIndex),
          ),
        )
        .filter((sink) => !allowedPairs.has(`${source.id}\0${sink.id}`))
        .map((sink) => `${source.id}->${sink.id}`),
    );
  if (document.rules.denyUnlistedFlows && unlistedFlows.length)
    throw new Error("EFFECTS_TRUST_BOUNDARY_UNLISTED_FLOW");
  return Object.freeze({
    format: "llang-effects-static-provenance",
    version: 1,
    boundaryCommitmentHash: fingerprintFor(document),
    programHash: graph.programHash,
    authorityDerivation: "static-not-data-derived",
    sources: Object.freeze(sourceResults),
    sinks: Object.freeze(sinkResults),
    flows: Object.freeze(flows),
    unlistedFlows: Object.freeze(unlistedFlows),
  });
}

export async function readEffectsTrustBoundary(
  file: string,
  requirements: ParsedEffectsRequirementContract,
  graph: CheckedEffectsGraph,
): Promise<ParsedEffectsTrustBoundary> {
  const absolute = resolve(file),
    snapshot = await readStableRegularFileSnapshot(
      absolute,
      MAX_BYTES,
      "INVALID_EFFECTS_TRUST_BOUNDARY_FILE",
    ),
    document = parseEffectsTrustBoundary(
      parseStrictJsonObject(decodeUtf8(snapshot.bytes, absolute), absolute),
    );
  if (
    document.requirements.id !== requirements.document.id ||
    document.requirements.revision !== requirements.document.revision ||
    document.requirements.commitmentHash !== requirements.commitmentHash
  )
    throw new Error("EFFECTS_TRUST_BOUNDARY_REQUIREMENTS_MISMATCH");
  const provenance = analyzeEffectsProvenance(document, graph);
  return Object.freeze({
    path: absolute,
    fileIdentity: Object.freeze({ dev: snapshot.dev, ino: snapshot.ino }),
    sourceHash: sha256(snapshot.bytes),
    commitmentHash: fingerprintFor(document),
    document,
    provenance,
    provenanceHash: fingerprintFor(provenance),
  });
}

export function effectsObservedFlowSummary(
  boundary: ParsedEffectsTrustBoundary,
  events: readonly EffectsTranscriptEvent[],
) {
  const requestOperations = new Map(
      events
        .filter(
          (event) =>
            event.kind === "request" && event.requestId && event.operation,
        )
        .map((event) => [event.requestId as string, event.operation as string]),
    ),
    requested = new Set(
      events
        .filter((event) => event.kind === "request" && event.operation)
        .map((event) => event.operation as string),
    ),
    responded = new Set(
      events
        .filter((event) => ["response", "stream-chunk"].includes(event.kind))
        .map((event) =>
          event.operation
            ? event.operation
            : event.requestId
              ? requestOperations.get(event.requestId)
              : undefined,
        )
        .filter((operation): operation is string => !!operation),
    ),
    sources = boundary.document.sources.map((source) => ({
      id: source.id,
      operation: source.operation,
      observed: responded.has(source.operation),
    })),
    sinks = boundary.document.sinks.map((sink) => ({
      id: sink.id,
      operation: sink.operation,
      observed: requested.has(sink.operation),
    })),
    sourceState = new Map(sources.map((item) => [item.id, item.observed])),
    sinkState = new Map(sinks.map((item) => [item.id, item.observed])),
    flows = boundary.document.allowedFlows.map((flow) => ({
      ...flow,
      observed:
        sourceState.get(flow.source) === true &&
        sinkState.get(flow.sink) === true,
    }));
  return Object.freeze({
    format: "llang-effects-observed-flow",
    version: 1,
    boundaryCommitmentHash: boundary.commitmentHash,
    sources: Object.freeze(sources),
    sinks: Object.freeze(sinks),
    flows: Object.freeze(flows),
    unlistedFlows: Object.freeze([]),
    rawExternalDataRecorded: false,
  });
}
