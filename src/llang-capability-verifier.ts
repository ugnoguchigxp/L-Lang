import type { executeCases } from "./llang-case-runner";
import {
  readLlangCapability,
  requestRevision,
  requirementCoverage,
  LLANG_CAPABILITY_VERIFIER,
} from "./llang-capability-contracts";
import { contentHash } from "./prompt-source";
import { WasmError } from "./wasm-contract";

async function runIsolated(
  snapshot: Awaited<ReturnType<typeof readLlangCapability>>,
): Promise<ReturnType<typeof executeCases>> {
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(
      new URL("./llang-capability-worker.ts", import.meta.url).href,
    );
    const timer = setTimeout(() => {
      worker.terminate();
      reject(
        new WasmError(
          "EXECUTION_TIMEOUT",
          "L-Lang capability verification exceeded 10 seconds",
        ),
      );
    }, 10_000);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message));
    };
    worker.onmessage = (event) => {
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else resolveResult(event.data.results);
    };
    worker.postMessage({
      build: snapshot.build,
      bytes: snapshot.bytes,
      suite: snapshot.suite,
    });
  });
}

export async function verifyLlangCapability(path: string) {
  const report = {
    version: 2 as const,
    verifier: LLANG_CAPABILITY_VERIFIER,
    packageHash: null as string | null,
    status: "error" as "pass" | "fail" | "error",
    acceptance: "not-run" as const,
    apiCalls: 0 as const,
    requestRevision: null as string | null,
    suiteHash: null as string | null,
    sourceHash: null as string | null,
    programHash: null as string | null,
    artifactHash: null as string | null,
    results: [] as ReturnType<typeof executeCases>,
    requirements: [] as { id: string; caseIds: string[] }[],
    uncoveredRequirements: [] as string[],
    coverage: "not-evaluated" as "evaluated" | "not-evaluated",
    diagnostics: [] as string[],
  };
  try {
    const snapshot = await readLlangCapability(path);
    report.packageHash = snapshot.packageHash;
    report.requestRevision = requestRevision(snapshot.request);
    report.suiteHash = contentHash(snapshot.suite);
    report.sourceHash = snapshot.checked.sourceHash;
    report.programHash = snapshot.checked.programHash;
    report.artifactHash = snapshot.build.wasmHash;
    const coverage = requirementCoverage(snapshot.request, snapshot.suite);
    report.coverage = coverage.coverage;
    report.requirements = coverage.requirements.map(({ id, caseIds }) => ({
      id,
      caseIds,
    }));
    report.uncoveredRequirements = coverage.uncoveredRequirements;
    report.results = await runIsolated(snapshot);
    if ((await readLlangCapability(path)).packageHash !== snapshot.packageHash)
      throw new WasmError(
        "INVALID_CAPABILITY",
        "package changed during verification",
      );
    report.status = report.results.some((item) => item.status === "error")
      ? "error"
      : report.results.some((item) => item.status === "fail") ||
          report.uncoveredRequirements.length
        ? "fail"
        : "pass";
  } catch (error) {
    report.diagnostics.push(
      (error instanceof Error ? error.message : String(error)).slice(0, 4096),
    );
  }
  return report;
}
