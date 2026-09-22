import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEffectValue,
  effectValueTypeJson,
  encodeEffectValue,
} from "./llang-effects-ir";
import {
  emitTypedEffectsWasm,
  TypedEffectsRuntime,
} from "./llang-effects-state-machine";
import type {
  EffectsTraceCaseModel,
  EffectsTraceEvent,
  EffectsTraceJson,
  EffectsTraceScenario,
} from "./llang-effects-trace-differential-oracle";
import { evaluateEffectsTraceReference } from "./llang-effects-trace-differential-reference";
import { emitEffectsGraphTypeScript } from "./llang-module-effects-build";
import {
  type CheckedEffectsGraph,
  loadEffectsModuleGraph,
} from "./llang-module-effects-graph";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";

export type EffectsTraceLane =
  | "oracle"
  | "reference"
  | "typescript"
  | "jsonc"
  | "wasm";
export const EFFECTS_TRACE_LANES: readonly EffectsTraceLane[] = Object.freeze([
  "oracle",
  "reference",
  "typescript",
  "jsonc",
  "wasm",
]);
export type EffectsTraceOutcomes = Readonly<
  Record<EffectsTraceLane, readonly EffectsTraceEvent[]>
>;
export type EffectsTraceHashes = Readonly<{
  sourceSetHash: string;
  interfaceHash: string;
  semanticProjection: string;
  loweredHash: string;
  wasmHash: string;
}>;
export type EffectsTraceHarnessStage =
  | "source-load"
  | "reference"
  | "typescript-emit"
  | "typescript-run"
  | "jsonc-round-trip"
  | "wasm-emit"
  | "wasm-run"
  | "trace-normalize";

export class EffectsTraceHarnessError extends Error {
  constructor(
    readonly stage: EffectsTraceHarnessStage,
    readonly scenarioIndex: number | undefined,
    cause: unknown,
  ) {
    super(
      `effects trace differential ${stage} failed${scenarioIndex === undefined ? "" : ` at scenario ${scenarioIndex}`}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "EffectsTraceHarnessError";
  }
}

async function stage<T>(
  name: EffectsTraceHarnessStage,
  run: () => T | Promise<T>,
  scenarioIndex?: number,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EffectsTraceHarnessError) throw error;
    throw new EffectsTraceHarnessError(name, scenarioIndex, error);
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function strictEffectsTraceJson(
  value: unknown,
  seen = new WeakSet<object>(),
): EffectsTraceJson {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite trace number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("cyclic trace array");
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key))
          return true;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !("value" in descriptor);
      }) ||
      Array.from({ length: value.length }, (_, index) => index).some(
        (index) => !Object.hasOwn(value, index),
      )
    )
      throw new Error("non-JSON trace array");
    seen.add(value);
    const result = value.map((item) => strictEffectsTraceJson(item, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  if (!plain(value)) throw new Error("non-plain trace value");
  if (seen.has(value)) throw new Error("cyclic trace record");
  seen.add(value);
  const result: Record<string, EffectsTraceJson> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      throw new Error("non-JSON trace record");
    result[key] = strictEffectsTraceJson(descriptor.value, seen);
  }
  seen.delete(value);
  return Object.freeze(result);
}

export function normalizeEffectsTrace(
  value: unknown,
): readonly EffectsTraceEvent[] {
  const normalized = strictEffectsTraceJson(value);
  if (!Array.isArray(normalized) || normalized.length < 2)
    throw new Error("invalid effects trace");
  const exact = (item: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(item).length === keys.length &&
    Object.keys(item).every((key) => keys.includes(key));
  for (const [index, raw] of normalized.entries()) {
    if (!plain(raw)) throw new Error("invalid effects trace event");
    if (raw.kind === "terminal") {
      if (index !== normalized.length - 1)
        throw new Error("terminal must be the final trace event");
      if (
        raw.status === "completed"
          ? !exact(raw, ["kind", "status", "result"])
          : !["host-failure", "permission-denied"].includes(
              String(raw.status),
            ) || !exact(raw, ["kind", "status"])
      )
        throw new Error("invalid effects terminal");
      continue;
    }
    if (
      !Number.isSafeInteger(raw.sequence) ||
      Number(raw.sequence) < 1 ||
      typeof raw.operation !== "string" ||
      !raw.operation ||
      !Number.isSafeInteger(raw.version) ||
      Number(raw.version) < 1
    )
      throw new Error("invalid effects trace event identity");
    if (raw.kind === "request" || raw.kind === "response") {
      if (!exact(raw, ["kind", "sequence", "operation", "version", "value"]))
        throw new Error("invalid effects value event");
      continue;
    }
    if (
      (raw.kind !== "host-failure" && raw.kind !== "permission-denied") ||
      !exact(raw, ["kind", "sequence", "operation", "version", "code"]) ||
      (raw.kind === "host-failure" && raw.code !== "HOST_FAILURE") ||
      (raw.kind === "permission-denied" && raw.code !== "PERMISSION_DENIED")
    )
      throw new Error("invalid effects failure event");
  }
  const events = normalized as unknown as readonly EffectsTraceEvent[];
  let expectedSequence = 1,
    pending:
      | Readonly<{ sequence: number; operation: string; version: number }>
      | undefined,
    lastResponse: EffectsTraceJson | undefined,
    failure: "host-failure" | "permission-denied" | undefined;
  for (const event of events.slice(0, -1)) {
    if (event.kind === "terminal")
      throw new Error("terminal must be the final trace event");
    if (failure) throw new Error("event after effects trace failure");
    if (event.sequence !== expectedSequence)
      throw new Error("non-contiguous effects trace sequence");
    if (event.kind === "request") {
      if (pending) throw new Error("overlapping effects trace requests");
      pending = event;
      continue;
    }
    if (event.kind === "response" || event.kind === "host-failure") {
      if (
        !pending ||
        event.sequence !== pending.sequence ||
        event.operation !== pending.operation ||
        event.version !== pending.version
      )
        throw new Error("unmatched effects trace outcome");
      pending = undefined;
      expectedSequence++;
      if (event.kind === "response") lastResponse = event.value;
      else failure = "host-failure";
      continue;
    }
    if (pending) throw new Error("permission denial with a pending request");
    failure = "permission-denied";
    expectedSequence++;
  }
  const terminal = events.at(-1);
  if (terminal?.kind !== "terminal")
    throw new Error("missing effects terminal");
  if (terminal.status === "completed") {
    if (
      pending ||
      failure ||
      lastResponse === undefined ||
      stableJson(terminal.result) !== stableJson(lastResponse)
    )
      throw new Error("invalid completed effects trace");
  } else if (pending || failure !== terminal.status) {
    throw new Error("effects terminal does not match failure");
  }
  return events;
}

export function sameEffectsTrace(
  left: readonly EffectsTraceEvent[],
  right: readonly EffectsTraceEvent[],
): boolean {
  return stableJson(left) === stableJson(right);
}

export function assertFiveEffectsTraceLanes(outcomes: EffectsTraceOutcomes) {
  const keys = Object.keys(outcomes);
  if (
    keys.length !== EFFECTS_TRACE_LANES.length ||
    EFFECTS_TRACE_LANES.some((lane) => !Object.hasOwn(outcomes, lane))
  )
    throw new Error("effects trace outcomes must contain all five lanes");
}

const graphProjection = (graph: CheckedEffectsGraph) => ({
  resultType: effectValueTypeJson(graph.program.resultType),
  operations: graph.manifest.operations,
  nodes: graph.program.nodes.map((node) => {
    if (node.kind !== "await")
      throw new Error("only await nodes are supported");
    return {
      kind: node.kind,
      operation: node.operation,
      version: node.version,
      requestType: effectValueTypeJson(node.requestType),
      responseType: effectValueTypeJson(node.responseType),
      request: encodeEffectValue(node.requestType, node.request),
    };
  }),
});

const flattenedSource = (graph: CheckedEffectsGraph) => {
  const [module, entry] = graph.entry.split("#") as [string, string];
  return {
    language: "l-lang" as const,
    version: 5 as const,
    kind: "module" as const,
    profile: "module-effects-v1" as const,
    module,
    entry,
    imports: [],
    operations: graph.manifest.operations.map((requirement) => {
      const definition = graph.registry.get(
        requirement.id,
        requirement.version,
      );
      if (!definition) throw new Error("missing operation definition");
      return definition;
    }),
    resultType: effectValueTypeJson(graph.program.resultType),
    nodes: graph.program.nodes.map((node) => {
      if (node.kind !== "await")
        throw new Error("only await nodes are supported");
      return {
        kind: "await" as const,
        operation: node.operation,
        version: node.version,
        request: encodeEffectValue(node.requestType, node.request),
      };
    }),
  };
};

async function runTypeScript(
  root: string,
  generatedSource: string,
  scenarios: readonly EffectsTraceScenario[],
): Promise<readonly (readonly EffectsTraceEvent[])[]> {
  const generatedPath = join(root, "program.generated.ts"),
    runnerPath = join(root, "runner.ts");
  await writeFile(generatedPath, generatedSource);
  const runner = `import { execute } from "./program.generated.ts";
const scenarios = ${JSON.stringify(scenarios)};
const results = [];
for (const scenario of scenarios) {
  const trace = []; let index = 0;
  try {
    const result = await execute({ invoke: async (request) => {
      const sequence = ++index, key = request.operation + "@" + request.version;
      if (!scenario.granted.includes(key)) {
        trace.push({ kind: "permission-denied", sequence, operation: request.operation, version: request.version, code: "PERMISSION_DENIED" });
        throw new Error("PERMISSION_DENIED");
      }
      trace.push({ kind: "request", sequence, operation: request.operation, version: request.version, value: request.payload });
      if (scenario.failureIndex === sequence - 1) {
        trace.push({ kind: "host-failure", sequence, operation: request.operation, version: request.version, code: "HOST_FAILURE" });
        throw new Error("HOST_FAILURE");
      }
      if (sequence > scenario.responses.length) throw new Error("SCRIPT_MISMATCH");
      const value = scenario.responses[sequence - 1];
      trace.push({ kind: "response", sequence, operation: request.operation, version: request.version, value });
      return value;
    }});
    if (index !== scenario.responses.length) throw new Error("SCRIPT_MISMATCH");
    trace.push({ kind: "terminal", status: "completed", result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "HOST_FAILURE") trace.push({ kind: "terminal", status: "host-failure" });
    else if (message === "PERMISSION_DENIED") trace.push({ kind: "terminal", status: "permission-denied" });
    else throw error;
  }
  results.push(trace);
}
console.log(JSON.stringify(results));
`;
  await writeFile(runnerPath, runner);
  const child = Bun.spawn([process.execPath, "run", runnerPath], {
      cwd: root,
      env: {},
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
    timeout = setTimeout(() => child.kill(), 5_000),
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  clearTimeout(timeout);
  if (exitCode !== 0)
    throw new Error(
      `generated TypeScript exited ${exitCode}: ${stderr.trim()}`,
    );
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== scenarios.length)
    throw new Error("generated TypeScript returned invalid traces");
  return Object.freeze(parsed.map(normalizeEffectsTrace));
}

function runWasm(
  graph: CheckedEffectsGraph,
  scenario: EffectsTraceScenario,
  emitted: ReturnType<typeof emitTypedEffectsWasm>,
): readonly EffectsTraceEvent[] {
  const runtime = new TypedEffectsRuntime(emitted.bytes, emitted.states),
    granted = new Set(scenario.granted),
    trace: EffectsTraceEvent[] = [];
  try {
    let outcome = runtime.start(),
      index = 0;
    while (outcome.request) {
      const request = outcome.request,
        state = emitted.states[request.state],
        requirement = graph.manifest.operations[request.operation];
      if (!state || !requirement)
        throw new Error("invalid Wasm request metadata");
      const sequence = index + 1,
        key = `${requirement.id}@${requirement.version}`;
      if (!granted.has(key)) {
        trace.push({
          kind: "permission-denied",
          sequence,
          operation: requirement.id,
          version: requirement.version,
          code: "PERMISSION_DENIED",
        });
        runtime.dispose();
        trace.push({ kind: "terminal", status: "permission-denied" });
        return Object.freeze(trace);
      }
      const requestValue = JSON.parse(
        new TextDecoder().decode(request.payload),
      );
      trace.push({
        kind: "request",
        sequence,
        operation: requirement.id,
        version: requirement.version,
        value: strictEffectsTraceJson(requestValue),
      });
      if (scenario.failureIndex === index) {
        trace.push({
          kind: "host-failure",
          sequence,
          operation: requirement.id,
          version: requirement.version,
          code: "HOST_FAILURE",
        });
        try {
          runtime.resume(request, false, 0);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "EFFECTS_WASM_FAULT: 6"
          )
            throw error;
        }
        trace.push({ kind: "terminal", status: "host-failure" });
        return Object.freeze(trace);
      }
      const encoded = scenario.responses[index];
      if (encoded === undefined) throw new Error("missing Wasm response");
      const value = decodeEffectValue(state.responseType, encoded);
      trace.push({
        kind: "response",
        sequence,
        operation: requirement.id,
        version: requirement.version,
        value: encodeEffectValue(state.responseType, value) as EffectsTraceJson,
      });
      index++;
      outcome = runtime.resume(request, true, value);
    }
    if (outcome.result === undefined || index !== scenario.responses.length)
      throw new Error("incomplete Wasm trace");
    trace.push({
      kind: "terminal",
      status: "completed",
      result: encodeEffectValue(
        graph.program.resultType,
        outcome.result,
      ) as EffectsTraceJson,
    });
    return Object.freeze(trace);
  } finally {
    runtime.dispose();
  }
}

export async function runEffectsTraceHarness(input: {
  source: string;
  model: EffectsTraceCaseModel;
  scenarios: readonly EffectsTraceScenario[];
  oracle: readonly (readonly EffectsTraceEvent[])[];
}): Promise<
  Readonly<{
    outcomes: readonly EffectsTraceOutcomes[];
    hashes: EffectsTraceHashes;
    flattenedJsonc: string;
  }>
> {
  const root = await mkdtemp(join(tmpdir(), "llang-effects-trace-"));
  try {
    await writeFile(join(root, "main.llang.jsonc"), input.source);
    const graph = await stage("source-load", () =>
        loadEffectsModuleGraph("main.llang.jsonc", root, "main"),
      ),
      originalProjection = fingerprintFor(graphProjection(graph));
    const generatedTypeScript = await stage("typescript-emit", () =>
        emitEffectsGraphTypeScript(graph),
      ),
      typescript = await stage("typescript-run", () =>
        runTypeScript(root, generatedTypeScript, input.scenarios),
      );
    const flattenedJsonc = `${JSON.stringify(flattenedSource(graph), null, 2)}\n`;
    await writeFile(join(root, "roundtrip.llang.jsonc"), flattenedJsonc);
    const jsonGraph = await stage("jsonc-round-trip", () =>
      loadEffectsModuleGraph("roundtrip.llang.jsonc", root, "main"),
    );
    if (
      jsonGraph.interfaceHash !== graph.interfaceHash ||
      fingerprintFor(graphProjection(jsonGraph)) !== originalProjection
    )
      throw new EffectsTraceHarnessError(
        "jsonc-round-trip",
        undefined,
        "semantic projection mismatch",
      );
    const emitted = await stage("wasm-emit", () =>
        emitTypedEffectsWasm(graph.program, graph.manifest.operations),
      ),
      jsonEmitted = await stage("jsonc-round-trip", () =>
        emitTypedEffectsWasm(jsonGraph.program, jsonGraph.manifest.operations),
      );
    if (jsonEmitted.contract.programHash !== emitted.contract.programHash)
      throw new EffectsTraceHarnessError(
        "jsonc-round-trip",
        undefined,
        "lowered hash mismatch",
      );
    const outcomes: EffectsTraceOutcomes[] = [];
    for (const [scenarioIndex, scenario] of input.scenarios.entries()) {
      const reference = await stage(
          "reference",
          () => evaluateEffectsTraceReference(graph, scenario),
          scenarioIndex,
        ),
        jsonc = await stage(
          "jsonc-round-trip",
          () => evaluateEffectsTraceReference(jsonGraph, scenario),
          scenarioIndex,
        ),
        wasm = await stage(
          "wasm-run",
          () => runWasm(graph, scenario, emitted),
          scenarioIndex,
        );
      outcomes.push(
        await stage(
          "trace-normalize",
          () =>
            Object.freeze({
              oracle: normalizeEffectsTrace(input.oracle[scenarioIndex]),
              reference: normalizeEffectsTrace(reference),
              typescript: normalizeEffectsTrace(typescript[scenarioIndex]),
              jsonc: normalizeEffectsTrace(jsonc),
              wasm: normalizeEffectsTrace(wasm),
            }),
          scenarioIndex,
        ),
      );
    }
    return Object.freeze({
      outcomes: Object.freeze(outcomes),
      hashes: Object.freeze({
        sourceSetHash: graph.sourceSetHash,
        interfaceHash: graph.interfaceHash,
        semanticProjection: originalProjection,
        loweredHash: emitted.contract.programHash,
        wasmHash: sha256(emitted.bytes),
      }),
      flattenedJsonc,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
