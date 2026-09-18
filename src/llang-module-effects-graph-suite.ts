import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeEffectValue,
  encodeEffectValue,
  parseEffectValueType,
  type EffectValue,
} from "./llang-effects-ir";
import { runTypedEffectsGraph } from "./llang-effects-typed-runtime";
import {
  TypedEffectsRuntime,
  type LoweredEffectState,
} from "./llang-effects-state-machine";
import { SESSION_STATUS } from "./llang-effects-wasm";
import { parseStrictJsonObject } from "./llang-jsonc";
import { loadEffectsModuleGraph } from "./llang-module-effects-graph";
import {
  readEffectsModuleBuildManifest,
  type EffectsModuleBuildManifest,
} from "./llang-module-effects-build";
import type { EffectsGrant, EffectsManifest } from "./llang-effects-contract";

export type TypedEffectsModuleSuite = Readonly<{
  format: "llang-module-suite";
  version: 5;
  profile: "module-effects-v1";
  mode: "typed";
  interfaceHash: string;
  cases: readonly Readonly<{
    id: string;
    events: readonly Readonly<{
      operation: string;
      version: number;
      request: unknown;
      response: unknown;
    }>[];
    expected: unknown;
  }>[];
}>;

const HASH = /^[0-9a-f]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

const fixtureGrant = (
  manifest: EffectsManifest,
  events: TypedEffectsModuleSuite["cases"][number]["events"],
): EffectsGrant => {
  const roots = new Set<string>(),
    origins = new Set<string>(),
    methods = new Set<string>(),
    headers = new Set<string>();
  for (const event of events) {
    if (!object(event.request)) continue;
    if (typeof event.request.path === "string") roots.add(event.request.path);
    if (typeof event.request.url === "string") {
      try {
        origins.add(new URL(event.request.url).origin);
      } catch {
        // Invalid URLs remain invalid when the runtime checks the target.
      }
    }
    if (typeof event.request.method === "string")
      methods.add(event.request.method.toUpperCase());
    if (Array.isArray(event.request.headers))
      for (const item of event.request.headers)
        if (object(item) && typeof item.name === "string")
          headers.add(item.name.toLowerCase());
  }
  return Object.freeze({
    operations: new Set(
      manifest.operations.map((item) => `${item.id}@${item.version}`),
    ),
    file: {
      roots: Object.freeze([...roots]),
      read: true,
      write: true,
      replace: true,
    },
    http: {
      origins,
      methods,
      requestHeaders: headers,
    },
    wallClock: true,
  });
};

export function parseTypedEffectsModuleSuite(
  value: unknown,
): TypedEffectsModuleSuite {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "profile",
      "mode",
      "interfaceHash",
      "cases",
    ]) ||
    value.format !== "llang-module-suite" ||
    value.version !== 5 ||
    value.profile !== "module-effects-v1" ||
    value.mode !== "typed" ||
    !HASH.test(String(value.interfaceHash)) ||
    !Array.isArray(value.cases) ||
    !value.cases.length ||
    value.cases.length > 1024
  )
    throw new Error("INVALID_TYPED_EFFECTS_SUITE");
  const ids = new Set<string>();
  for (const item of value.cases) {
    if (
      !object(item) ||
      !exact(item, ["id", "events", "expected"]) ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      !Array.isArray(item.events) ||
      item.events.length > 1024
    )
      throw new Error("INVALID_TYPED_EFFECTS_SUITE");
    ids.add(item.id);
    for (const event of item.events)
      if (
        !object(event) ||
        !exact(event, ["operation", "version", "request", "response"]) ||
        typeof event.operation !== "string" ||
        !Number.isInteger(event.version) ||
        Number(event.version) < 1
      )
        throw new Error("INVALID_TYPED_EFFECTS_SUITE_EVENT");
  }
  return value as unknown as TypedEffectsModuleSuite;
}

export async function readTypedEffectsModuleSuite(
  path: string,
): Promise<TypedEffectsModuleSuite> {
  const absolute = resolve(path),
    info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
    throw new Error("INVALID_TYPED_EFFECTS_SUITE_FILE");
  return parseTypedEffectsModuleSuite(
    parseStrictJsonObject(await readFile(absolute, "utf8"), absolute),
  );
}

export async function testEffectsModuleGraph(options: {
  entry: string;
  root: string;
  entryName: string;
  suite: string;
}): Promise<
  Readonly<{
    ok: boolean;
    programHash: string;
    interfaceHash: string;
    cases: readonly Readonly<{
      id: string;
      ok: boolean;
      actual?: unknown;
      error?: string;
    }>[];
  }>
> {
  const graph = await loadEffectsModuleGraph(
      options.entry,
      options.root,
      options.entryName,
    ),
    suite = await readTypedEffectsModuleSuite(options.suite);
  if (suite.interfaceHash !== graph.interfaceHash)
    throw new Error("EFFECTS_SUITE_INTERFACE_MISMATCH");
  const cases = [];
  for (const item of suite.cases) {
    let index = 0;
    try {
      const execution = await runTypedEffectsGraph({
          graph,
          grant: fixtureGrant(graph.manifest, item.events),
          execute: async (operation, request) => {
            const event = item.events[index++];
            if (
              !event ||
              event.operation !== operation.id ||
              event.version !== operation.version
            )
              throw new Error("REPLAY_MISMATCH");
            const requestType = parseEffectValueType(operation.requestType),
              responseType = parseEffectValueType(operation.responseType);
            if (
              JSON.stringify(encodeEffectValue(requestType, request)) !==
              JSON.stringify(event.request)
            )
              throw new Error("REPLAY_MISMATCH");
            return decodeEffectValue(responseType, event.response);
          },
        }),
        actual = encodeEffectValue(graph.program.resultType, execution.result),
        ok =
          index === item.events.length &&
          JSON.stringify(actual) === JSON.stringify(item.expected);
      cases.push(Object.freeze({ id: item.id, ok, actual }));
    } catch (error) {
      cases.push(
        Object.freeze({
          id: item.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return Object.freeze({
    ok: cases.every((item) => item.ok),
    programHash: graph.programHash,
    interfaceHash: graph.interfaceHash,
    cases: Object.freeze(cases),
  });
}

export async function verifyTypedEffectsModuleBundle(
  manifestPath: string,
  suitePath: string,
): Promise<
  Readonly<{
    ok: boolean;
    manifest: EffectsModuleBuildManifest;
    cases: readonly Readonly<{
      id: string;
      ok: boolean;
      actual?: unknown;
      error?: string;
    }>[];
  }>
> {
  const { manifest, artifacts } =
      await readEffectsModuleBuildManifest(manifestPath),
    suite = await readTypedEffectsModuleSuite(suitePath),
    wasm = manifest.wasm,
    resultType = parseEffectValueType(manifest.resultType);
  if (
    suite.interfaceHash !== manifest.interfaceHash ||
    !wasm ||
    !("layout" in wasm.contract) ||
    wasm.contract.layout !== "typed-wire-v1" ||
    !wasm.states
  )
    throw new Error("EFFECTS_SUITE_INTERFACE_MISMATCH");
  const bytes = artifacts.get(wasm.path);
  if (!bytes) throw new Error("INVALID_ARTIFACT: missing effects Wasm");
  const states: readonly LoweredEffectState[] = Object.freeze(
      wasm.states.map((state) =>
        Object.freeze({
          kind: state.kind,
          operation: state.operation,
          requestType: parseEffectValueType(state.requestType),
          responseType: parseEffectValueType(state.responseType),
          request: 0 as EffectValue,
          payload: new Uint8Array(),
        }),
      ),
    ),
    cases = suite.cases.map((item) => {
      const runtime = new TypedEffectsRuntime(bytes, states);
      let index = 0;
      try {
        let outcome = runtime.start();
        while (outcome.status === SESSION_STATUS.YIELDED) {
          const request = outcome.request,
            state = request && states[request.state],
            event = item.events[index++];
          if (!request || !state || !event) throw new Error("REPLAY_MISMATCH");
          const requirement =
              state.kind === "task"
                ? { id: "$task.join", version: 1 }
                : manifest.operations[state.operation],
            actualRequest = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(request.payload),
            );
          if (
            !requirement ||
            event.operation !== requirement.id ||
            event.version !== requirement.version ||
            JSON.stringify(actualRequest) !== JSON.stringify(event.request)
          )
            throw new Error("REPLAY_MISMATCH");
          outcome = runtime.resume(
            request,
            true,
            decodeEffectValue(state.responseType, event.response),
          );
        }
        if (
          outcome.status !== SESSION_STATUS.DONE ||
          outcome.result === undefined ||
          index !== item.events.length
        )
          throw new Error("REPLAY_INCOMPLETE");
        const actual = encodeEffectValue(resultType, outcome.result);
        return Object.freeze({
          id: item.id,
          ok: JSON.stringify(actual) === JSON.stringify(item.expected),
          actual,
        });
      } catch (error) {
        return Object.freeze({
          id: item.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        runtime.dispose();
      }
    });
  return Object.freeze({
    ok: cases.every((item) => item.ok),
    manifest,
    cases: Object.freeze(cases),
  });
}
