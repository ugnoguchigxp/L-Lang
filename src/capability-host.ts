import {
  readCapabilitySnapshot,
  verifyCapabilityPackage,
} from "./capability-snapshot";
import { caseInput } from "./capability-tests";
import { encodeInput, record, WasmError } from "./wasm-contract";

export const HOST_PROTOCOL = "llang-host-v1";
export type HostRequest = {
  protocol: typeof HOST_PROTOCOL;
  requestId: string;
  operation: "inspect" | "verify" | "invoke";
  packageHash: string;
  input?: Record<string, unknown>;
  undefinedFields?: string[];
  timeoutMs?: number;
};
export function parseHostRequest(raw: unknown): HostRequest {
  const r = record(raw, [
    "protocol",
    "requestId",
    "operation",
    "packageHash",
    "input",
    "undefinedFields",
    "timeoutMs",
  ]);
  if (
    r.protocol !== HOST_PROTOCOL ||
    typeof r.requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(r.requestId) ||
    !["inspect", "verify", "invoke"].includes(String(r.operation)) ||
    typeof r.packageHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.packageHash)
  )
    throw new Error("invalid host request");
  if (r.operation === "invoke") {
    if (
      !r.input ||
      typeof r.input !== "object" ||
      Array.isArray(r.input) ||
      !Array.isArray(r.undefinedFields) ||
      r.undefinedFields.some(
        (f) => typeof f !== "string" || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(f),
      ) ||
      new Set(r.undefinedFields).size !== r.undefinedFields.length ||
      r.undefinedFields.some((f) => Object.hasOwn(r.input as object, f)) ||
      !Number.isSafeInteger(r.timeoutMs) ||
      Number(r.timeoutMs) < 1 ||
      Number(r.timeoutMs) > 10000
    )
      throw new Error("invalid invocation envelope");
  } else if (
    ["input", "undefinedFields", "timeoutMs"].some((k) => Object.hasOwn(r, k))
  )
    throw new Error("unexpected invocation fields");
  return r as HostRequest;
}
export async function invokeSnapshot(
  snapshot: Awaited<ReturnType<typeof readCapabilitySnapshot>>,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./capability-invoke-worker.ts", import.meta.url).href,
    );
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new WasmError("EXECUTION_TIMEOUT", "invocation timed out"));
    }, timeoutMs);
    worker.onerror = () => {
      finish();
      reject(new Error("worker execution failed"));
    };
    worker.onmessage = (event) => {
      finish();
      if (typeof event.data.value !== "boolean" || event.data.error)
        reject(new Error("invalid worker result"));
      else resolve(event.data.value);
    };
    worker.postMessage({ build: snapshot.build, bytes: snapshot.bytes, input });
  });
}
export async function runHostRequest(manifestPath: string, raw: unknown) {
  const started = Date.now();
  let request: HostRequest | undefined;
  let packageHash: string | null = null;
  const base = () => ({
    protocol: HOST_PROTOCOL,
    requestId: request?.requestId ?? null,
    packageHash,
    elapsedMs: Date.now() - started,
    apiCalls: 0,
  });
  try {
    request = parseHostRequest(raw);
  } catch {
    return { ...base(), status: "error", error: "invalid-request" };
  }
  try {
    const snapshot = await readCapabilitySnapshot(manifestPath);
    packageHash = snapshot.packageHash;
    if (packageHash !== request.packageHash)
      return { ...base(), status: "error", error: "package-mismatch" };
    let result: unknown;
    if (request.operation === "invoke") {
      const input = caseInput({
        input: request.input ?? {},
        undefinedFields: request.undefinedFields ?? [],
      });
      encodeInput(snapshot.source.contract, input);
      result = {
        value: await invokeSnapshot(
          snapshot,
          input,
          request.timeoutMs ?? 10000,
        ),
      };
    } else if (request.operation === "verify") {
      const report = await verifyCapabilityPackage(manifestPath);
      if (report.packageHash !== packageHash)
        return { ...base(), status: "error", error: "package-mismatch" };
      result = report;
    } else {
      result = {
        manifest: snapshot.manifest,
        contract: snapshot.source.contract,
        requirements: snapshot.source.requirements,
        verification: "not-run",
        acceptance: "not-run",
      };
    }
    if (
      (await readCapabilitySnapshot(manifestPath)).packageHash !== packageHash
    )
      return { ...base(), status: "error", error: "package-mismatch" };
    return { ...base(), status: "ok", result };
  } catch (error) {
    return {
      ...base(),
      status: "error",
      error:
        error instanceof WasmError && error.code === "INVALID_INPUT"
          ? "invalid-input"
          : error instanceof WasmError && error.code === "EXECUTION_TIMEOUT"
            ? "timeout"
            : "execution-error",
    };
  }
}
