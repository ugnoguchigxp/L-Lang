import { randomUUID } from "node:crypto";
import {
  DEFAULT_EFFECTS_LIMITS,
  type EffectsGrant,
  type EffectsManifest,
  type HostOperationRegistry,
  type OperationDefinition,
  ResourceLedger,
} from "./llang-effects-contract";
import {
  EffectsSession,
  type HostRequest,
  type OperationOutcome,
  type TranscriptEntry,
} from "./llang-effects-session";
import {
  LinearEffectsRuntime,
  type LinearHostRequest,
  SESSION_STATUS,
} from "./llang-effects-wasm";

export type LinearOperationExecutor = (
  request: HostRequest,
  context: Readonly<{ signal: AbortSignal }>,
) => Promise<OperationOutcome>;

export type LinearRequestMapper = (
  request: LinearHostRequest,
  operation: OperationDefinition,
) => Omit<HostRequest, "taskId" | "operation" | "version" | "payload">;

export type LinearEffectsExecution = Readonly<{
  result: number;
  transcript: readonly TranscriptEntry[];
  ledger: ResourceLedger;
}>;

const cancelled = (): OperationOutcome => ({
  ok: false,
  error: { code: "cancelled", outcome: "unknown" },
});

const internal = (): OperationOutcome => ({
  ok: false,
  error: { code: "internal", outcome: "unknown" },
});

const timedOut = (): OperationOutcome => ({
  ok: false,
  error: { code: "timeout", outcome: "unknown" },
});

const responseValue = (outcome: OperationOutcome): number => {
  if (!outcome.ok) return 0;
  if (
    !Number.isInteger(outcome.value) ||
    Number(outcome.value) < -2147483648 ||
    Number(outcome.value) > 2147483647
  )
    throw new Error("INVALID_RESPONSE: expected i32");
  return Number(outcome.value);
};

/**
 * Runs the initial linear effects ABI through the same manifest, grant,
 * resource-ledger and transcript boundary used by native host adapters.
 */
export async function runLinearEffects(options: {
  wasm: Uint8Array;
  manifest: EffectsManifest;
  registry: HostOperationRegistry;
  grant: EffectsGrant;
  execute: LinearOperationExecutor;
  mapRequest?: LinearRequestMapper;
  ledger?: ResourceLedger;
  sessionId?: string;
  startedAtMs?: number;
  deadlineMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<LinearEffectsExecution> {
  const now = options.now ?? Date.now,
    startedAtMs = options.startedAtMs ?? now(),
    ledger = options.ledger ?? new ResourceLedger(DEFAULT_EFFECTS_LIMITS),
    session = new EffectsSession(
      options.sessionId ?? randomUUID(),
      options.manifest,
      options.registry,
      options.grant,
      ledger,
      startedAtMs,
      options.deadlineMs ?? startedAtMs + 30_000,
    ),
    runtime = new LinearEffectsRuntime(options.wasm);
  let currentAbort: AbortController | undefined,
    stopCurrent: ((outcome: OperationOutcome) => void) | undefined;
  const abort = () => {
    currentAbort?.abort(options.signal?.reason);
    stopCurrent?.(cancelled());
    session.cancel("abort", now());
    runtime.cancel();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) {
      abort();
      throw new Error("CANCELLED");
    }
    let state = runtime.start();
    while (state.status === SESSION_STATUS.YIELDED) {
      const wire = state.request,
        requirement = wire && options.manifest.operations[wire.operation];
      if (!wire || !requirement)
        throw new Error("INVALID_ARTIFACT: operation index");
      const operation = options.registry.get(
        requirement.id,
        requirement.version,
      );
      if (!operation) throw new Error("INVALID_ARTIFACT: operation contract");
      const mapped = options.mapRequest?.(wire, operation) ?? {},
        request: HostRequest = {
          taskId: 0,
          operation: requirement.id,
          version: requirement.version,
          payload: wire.payload,
          ...mapped,
        },
        envelope = session.dispatch(request, now());
      currentAbort = new AbortController();
      if (options.signal?.aborted) currentAbort.abort(options.signal.reason);
      let outcome: OperationOutcome;
      const remainingMs = Math.min(
        2_147_483_647,
        Math.max(0, session.deadlineMs - now()),
      );
      let stop!: (outcome: OperationOutcome) => void;
      const stopped = new Promise<OperationOutcome>((resolve) => {
          stop = resolve;
        }),
        timer = setTimeout(() => {
          currentAbort?.abort("deadline");
          stop(timedOut());
        }, remainingMs);
      stopCurrent = stop;
      try {
        const execution = Promise.resolve()
          .then(() =>
            options.execute(request, {
              signal: currentAbort?.signal ?? AbortSignal.abort(),
            }),
          )
          .catch(() =>
            currentAbort?.signal.aborted ? cancelled() : internal(),
          );
        outcome = await Promise.race([execution, stopped]);
      } finally {
        clearTimeout(timer);
        stopCurrent = undefined;
        currentAbort = undefined;
      }
      const event = session.settle(envelope.id, outcome, now());
      if (!event) throw new Error("CANCELLED");
      try {
        state = runtime.resume(wire, {
          ok: event.outcome.ok,
          value: responseValue(event.outcome),
        });
      } catch (error) {
        session.finish("failed");
        throw error;
      }
    }
    if (state.status !== SESSION_STATUS.DONE || state.result === undefined)
      throw new Error("EFFECTS_RUNTIME_INCOMPLETE");
    session.finish("done");
    return Object.freeze({
      result: state.result,
      transcript: session.transcript(),
      ledger,
    });
  } catch (error) {
    if (session.status === "active") session.finish("failed");
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    runtime.dispose();
  }
}
