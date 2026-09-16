import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-file";
import {
  packageCapability,
  parseCapabilityMetadata,
  verifyCapability,
  writeCapabilityReport,
} from "./capability-package";
import {
  type DevelopmentAgent,
  type DevelopmentRequest,
  type DevelopmentStage,
  implementationRequest,
  parseAgentReply,
  parseGeneratedTests,
  testGenerationRequest,
} from "./capability-test-agent";
import { invalid } from "./capability-tests";
import { resolveContainedFile } from "./contained-path";
import { parseElaborationResult } from "./elaboration-result";
import { type ResolverReply, resolvePromptSource } from "./prompt-resolution";
import {
  contentHash,
  createPromptSource,
  parsePromptSource,
  readJson,
} from "./prompt-source";
import { record, WasmError } from "./wasm-contract";

export type DevelopmentConfig = {
  version: 1;
  mode: "fixture" | "live" | "replay";
  model: string;
  maxCalls: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxWallMs: number;
  agent?: "codex-sdk";
};
export function parseDevelopmentConfig(input: unknown): DevelopmentConfig {
  const c = record(input, [
    "version",
    "mode",
    "model",
    "maxCalls",
    "maxOutputTokens",
    "maxTotalTokens",
    "maxWallMs",
    "agent",
  ]);
  if (
    c.version !== 1 ||
    !["fixture", "live", "replay"].includes(String(c.mode))
  )
    invalid("invalid development config");
  if (typeof c.model !== "string" || !c.model.trim() || c.model.length > 256)
    invalid("model is required");
  for (const [key, min, max] of [
    ["maxCalls", 1, 3],
    ["maxOutputTokens", 256, 16384],
    ["maxTotalTokens", 1, 10_000_000],
    ["maxWallMs", 1, 3_600_000],
  ] as const)
    if (
      !Number.isSafeInteger(c[key]) ||
      Number(c[key]) < min ||
      Number(c[key]) > max
    )
      invalid(`invalid ${key}`);
  if (
    c.agent !== undefined &&
    (c.agent !== "codex-sdk" || c.model !== "gpt-5.6-terra")
  )
    invalid("Codex SDK requires gpt-5.6-terra with medium reasoning");
  return { ...c } as DevelopmentConfig;
}
export const fixtureConfig: DevelopmentConfig = {
  version: 1,
  mode: "fixture",
  model: "fixture",
  maxCalls: 3,
  maxOutputTokens: 4096,
  maxTotalTokens: 1_000_000,
  maxWallMs: 120_000,
};
type CallRecord = {
  stage: DevelopmentStage;
  request: DevelopmentRequest;
  requestHash: string;
  reply: ResolverReply | null;
  response: unknown;
  error: string | null;
};
export type DevelopmentRun = {
  version: 1;
  protocol: "capability-development-v1";
  complete: boolean;
  status: "running" | "pass" | "fail" | "unresolved" | "error" | "stopped";
  sourceHash: string;
  metadataHash: string;
  config: DevelopmentConfig;
  suiteHash: string | null;
  apiCalls: number;
  logicalCalls: number;
  usedTokens: number;
  calls: CallRecord[];
  attempts: {
    index: number;
    packageHash: string;
    irHash: string;
    status: "pass" | "fail" | "error";
  }[];
  stopReason: string | null;
  acceptance: "not-run";
  mutation: "not-run";
};
function message(error: unknown) {
  return (
    (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
    "Unknown error"
  );
}
export async function developCapability(
  sourceInput: unknown,
  metadataInput: unknown,
  configInput: unknown,
  agent: DevelopmentAgent,
  outDirectory: string,
) {
  const source = parsePromptSource(structuredClone(sourceInput));
  const metadata = parseCapabilityMetadata(metadataInput);
  const config = parseDevelopmentConfig(configInput);
  if (metadata.id !== source.id) invalid("metadata id differs from source");
  const root = resolve(outDirectory);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { recursive: false });
  const run: DevelopmentRun = {
    version: 1,
    protocol: "capability-development-v1",
    complete: false,
    status: "running",
    sourceHash: contentHash(source),
    metadataHash: contentHash(metadata),
    config,
    suiteHash: null,
    apiCalls: 0,
    logicalCalls: 0,
    usedTokens: 0,
    calls: [],
    attempts: [],
    stopReason: null,
    acceptance: "not-run",
    mutation: "not-run",
  };
  const started = Date.now();
  async function checkpoint() {
    const text = JSON.stringify({ ...run, checksum: contentHash(run) });
    if (Buffer.byteLength(text) > 1024 * 1024)
      invalid("run record exceeds size limit");
    await atomicWriteFile(resolve(root, "run.json"), text);
  }
  await writeFile(resolve(root, "source.json"), JSON.stringify(source), {
    flag: "wx",
  });
  await writeFile(resolve(root, "metadata.json"), JSON.stringify(metadata), {
    flag: "wx",
  });
  await checkpoint();
  function deadline() {
    if (Date.now() - started >= config.maxWallMs)
      throw new WasmError("DEVELOPMENT_LIMIT", "wall-clock limit reached");
  }
  async function readFixed(name: string) {
    return readJson(
      await resolveContainedFile(root, name, "fixed development input", {
        rejectSymbolicLinks: true,
      }),
    );
  }
  async function unchanged() {
    deadline();
    if (
      contentHash(await readFixed("source.json")) !== run.sourceHash ||
      contentHash(await readFixed("metadata.json")) !== run.metadataHash ||
      (run.suiteHash !== null &&
        contentHash(await readFixed("tests.json")) !== run.suiteHash)
    )
      invalid("fixed development inputs changed");
  }
  async function call(request: DevelopmentRequest): Promise<ResolverReply> {
    await unchanged();
    if (run.logicalCalls >= config.maxCalls)
      throw new WasmError("DEVELOPMENT_LIMIT", "call limit reached");
    // UTF-8 bytes plus conservative framing allowance reserve input before dispatch.
    const requestBytes = Buffer.byteLength(JSON.stringify(request));
    // Codex includes its own system prompt. This is a reservation, not a provider hard cap.
    const inputReservation =
      config.agent === "codex-sdk" ? 64 * 1024 : requestBytes + 4096;
    if (requestBytes > 60 * 1024 || inputReservation > 64 * 1024)
      throw new WasmError(
        "DEVELOPMENT_LIMIT",
        "input reservation exceeds limit",
      );
    const reservation = inputReservation + config.maxOutputTokens;
    if (
      config.mode === "live" &&
      run.usedTokens + reservation > config.maxTotalTokens
    )
      throw new WasmError(
        "DEVELOPMENT_LIMIT",
        "insufficient token budget for reserved call",
      );
    const entry: CallRecord = {
      stage: request.stage,
      request: structuredClone(request),
      requestHash: contentHash(request),
      reply: null,
      response: null,
      error: null,
    };
    run.calls.push(entry);
    run.logicalCalls++;
    if (config.mode === "live") run.apiCalls++;
    await checkpoint();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        agent(structuredClone(request), controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new WasmError(
                  "DEVELOPMENT_LIMIT",
                  "agent response deadline exceeded",
                ),
              ),
            Math.max(1, config.maxWallMs - (Date.now() - started)),
          );
        }),
      ]);
      if (Buffer.byteLength(JSON.stringify(raw)) > 64 * 1024)
        invalid("agent response exceeds 64 KiB");
      entry.response = structuredClone(raw);
      entry.reply = parseAgentReply(structuredClone(raw));
      if (config.mode === "live") {
        if (!entry.reply.usage) {
          run.usedTokens += reservation;
          throw new WasmError(
            "DEVELOPMENT_LIMIT",
            "live usage missing; reservation retained",
          );
        }
        run.usedTokens += entry.reply.usage.totalTokens;
        if (
          entry.reply.usage.inputTokens > inputReservation ||
          entry.reply.usage.outputTokens > config.maxOutputTokens ||
          run.usedTokens > config.maxTotalTokens
        )
          throw new WasmError(
            "DEVELOPMENT_LIMIT",
            "token reservation exceeded",
          );
      }
      await unchanged();
      return entry.reply;
    } catch (error) {
      entry.error = message(error);
      if (config.mode === "live" && !entry.reply) run.usedTokens += reservation;
      throw error;
    } finally {
      controller.abort();
      if (timer) clearTimeout(timer);
      await checkpoint();
    }
  }
  try {
    const tests = parseGeneratedTests(
      (await call(testGenerationRequest(source))).result,
      source,
    );
    if (tests.outcome !== "generated") {
      run.status = tests.outcome;
      run.stopReason = tests.diagnostics.join("; ");
    } else {
      run.suiteHash = contentHash(tests.suite);
      await writeFile(
        resolve(root, "tests.json"),
        JSON.stringify(tests.suite),
        { flag: "wx" },
      );
      await checkpoint();
      let previous: Parameters<typeof implementationRequest>[1];
      for (let index = 0; index < 2; index++) {
        const reply = await call(await implementationRequest(source, previous));
        const result = parseElaborationResult(reply.result);
        if (result.outcome === "unresolved") {
          run.status = "unresolved";
          run.stopReason = result.diagnostics.join("; ");
          break;
        }
        const irHash = contentHash(result.body);
        if (previous && irHash === contentHash(previous.body)) {
          run.status = "stopped";
          run.stopReason = "same IR resubmitted";
          break;
        }
        await unchanged();
        const attempt = resolve(root, `attempt-${index}`);
        await mkdir(attempt);
        const sourcePath = resolve(attempt, "source.json");
        await createPromptSource(sourcePath, source);
        await resolvePromptSource(sourcePath, async () => reply);
        const candidate = await packageCapability(
          sourcePath,
          resolve(root, "tests.json"),
          metadata,
          resolve(attempt, "candidate"),
        );
        const report = await verifyCapability(candidate.manifest);
        await writeCapabilityReport(
          resolve(attempt, "report.json"),
          report,
          candidate.manifest,
        );
        run.attempts.push({
          index,
          packageHash: candidate.packageHash,
          irHash,
          status: report.status,
        });
        await checkpoint();
        await unchanged();
        if (report.status !== "fail") {
          run.status = report.status;
          run.stopReason =
            report.status === "error" ? report.diagnostics.join("; ") : null;
          break;
        }
        if (index === 1) {
          run.status = "fail";
          run.stopReason = "unit test mismatch after allowed attempts";
        }
        previous = {
          body: result.body,
          packageHash: candidate.packageHash,
          failures: report.results
            .filter((r) => r.status === "fail")
            .map((r) => ({
              ...r,
              test: tests.suite.cases.find(
                (c) => c.id === r.id && r.origin === "suite",
              ),
            })),
        };
      }
    }
  } catch (error) {
    run.status =
      error instanceof WasmError && error.code === "DEVELOPMENT_LIMIT"
        ? "stopped"
        : "error";
    run.stopReason = message(error);
  }
  run.complete = true;
  await checkpoint();
  return run;
}
export function fixtureDevelopmentAgent(input: unknown): DevelopmentAgent {
  const f = record(input, ["version", "responses"]);
  if (f.version !== 1 || !Array.isArray(f.responses) || f.responses.length > 3)
    invalid("invalid development fixtures");
  const responses = f.responses.map((raw) => {
    const r = record(raw, ["stage", "reply"]);
    if (!["tests", "implementation", "repair"].includes(String(r.stage)))
      invalid("invalid fixture stage");
    return { stage: r.stage, reply: parseAgentReply(r.reply) };
  });
  let position = 0;
  return async (request) => {
    const next = responses[position++];
    if (!next || next.stage !== request.stage)
      invalid("fixture response missing or out of order");
    return structuredClone(next.reply);
  };
}
export function parseDevelopmentRun(input: unknown): DevelopmentRun {
  const raw = record(input, [
    "version",
    "protocol",
    "complete",
    "status",
    "sourceHash",
    "metadataHash",
    "config",
    "suiteHash",
    "apiCalls",
    "logicalCalls",
    "usedTokens",
    "calls",
    "attempts",
    "stopReason",
    "acceptance",
    "mutation",
    "checksum",
  ]);
  const { checksum, ...unsigned } = raw;
  if (
    checksum !== contentHash(unsigned) ||
    raw.version !== 1 ||
    raw.protocol !== "capability-development-v1" ||
    typeof raw.complete !== "boolean" ||
    !["running", "pass", "fail", "unresolved", "error", "stopped"].includes(
      String(raw.status),
    ) ||
    (raw.status === "running") === raw.complete ||
    raw.acceptance !== "not-run" ||
    raw.mutation !== "not-run"
  )
    invalid("invalid development run contract");
  for (const key of ["sourceHash", "metadataHash", "suiteHash"])
    if (
      !(key === "suiteHash" && raw[key] === null) &&
      (typeof raw[key] !== "string" || !/^[a-f0-9]{64}$/.test(String(raw[key])))
    )
      invalid("invalid development hash");
  const config = parseDevelopmentConfig(raw.config);
  if (
    !Array.isArray(raw.calls) ||
    raw.calls.length > config.maxCalls ||
    raw.logicalCalls !== raw.calls.length ||
    raw.apiCalls !== (config.mode === "live" ? raw.calls.length : 0) ||
    !Number.isSafeInteger(raw.usedTokens) ||
    Number(raw.usedTokens) < 0 ||
    (raw.stopReason !== null &&
      (typeof raw.stopReason !== "string" || raw.stopReason.length > 4096))
  )
    invalid("invalid development counters");
  raw.calls.forEach((value, index) => {
    const c = record(value, [
      "stage",
      "request",
      "requestHash",
      "reply",
      "response",
      "error",
    ]);
    const request = record(c.request, [
      "stage",
      "instruction",
      "input",
      "schema",
    ]);
    if (
      !Object.hasOwn(c, "response") ||
      c.stage !== ["tests", "implementation", "repair"][index] ||
      request.stage !== c.stage ||
      typeof request.instruction !== "string" ||
      !Object.hasOwn(request, "input") ||
      !request.schema ||
      typeof request.schema !== "object" ||
      c.requestHash !== contentHash(c.request) ||
      (c.error !== null && typeof c.error !== "string")
    )
      invalid("invalid recorded call");
    if (
      c.reply !== null &&
      contentHash(parseAgentReply(c.reply)) !==
        contentHash(parseAgentReply(c.response))
    )
      invalid("recorded response mismatch");
    if (raw.complete && c.reply === null && c.error === null)
      invalid("incomplete recorded call");
  });
  if (!Array.isArray(raw.attempts) || raw.attempts.length > 2)
    invalid("invalid attempts");
  raw.attempts.forEach((value, index) => {
    const a = record(value, ["index", "packageHash", "irHash", "status"]);
    if (
      a.index !== index ||
      !["pass", "fail", "error"].includes(String(a.status)) ||
      !/^[a-f0-9]{64}$/.test(String(a.packageHash)) ||
      !/^[a-f0-9]{64}$/.test(String(a.irHash))
    )
      invalid("invalid attempt");
  });
  if (
    (raw.status === "pass" || raw.status === "fail") &&
    (raw.suiteHash === null || raw.attempts.at(-1)?.status !== raw.status)
  )
    invalid("development result lacks matching attempt");
  return unsigned as DevelopmentRun;
}

export async function replayDevelopment(directory: string, output: string) {
  const root = resolve(directory);
  async function read(name: string) {
    return readJson(
      await resolveContainedFile(root, name, "development snapshot", {
        rejectSymbolicLinks: true,
      }),
    );
  }
  const raw = parseDevelopmentRun(await read("run.json"));
  if (!raw.complete || !raw.calls.length)
    invalid("run has no completed calls to replay");
  const source = await read("source.json"),
    metadata = await read("metadata.json");
  if (
    contentHash(source) !== raw.sourceHash ||
    contentHash(metadata) !== raw.metadataHash ||
    (raw.suiteHash !== null &&
      contentHash(await read("tests.json")) !== raw.suiteHash)
  )
    invalid("development snapshot hash mismatch");
  const calls = raw.calls.map((value) => {
    const c = record(value, [
      "stage",
      "request",
      "requestHash",
      "reply",
      "response",
      "error",
    ]);
    if (c.requestHash !== contentHash(c.request))
      invalid("request hash mismatch");
    return c;
  });
  let position = 0;
  const original = parseDevelopmentConfig(raw.config);
  const replay = await developCapability(
    source,
    metadata,
    {
      ...original,
      mode: "replay",
      maxWallMs: Math.max(original.maxWallMs, 120000),
    },
    async (request) => {
      const c = calls[position++];
      if (
        !c ||
        c.stage !== request.stage ||
        c.requestHash !== contentHash(request)
      )
        invalid("replay request differs from recorded request");
      if (c.error) {
        if (String(c.error).startsWith("DEVELOPMENT_LIMIT:"))
          throw new WasmError("DEVELOPMENT_LIMIT", String(c.error));
        throw new Error(String(c.error));
      }
      return parseAgentReply(c.reply);
    },
    output,
  );
  const comparable = ["pass", "fail", "unresolved"].includes(raw.status);
  const match =
    !comparable ||
    (position === calls.length &&
      replay.status === raw.status &&
      replay.suiteHash === raw.suiteHash &&
      contentHash(replay.attempts) === contentHash(raw.attempts));
  await writeFile(
    resolve(output, "replay-check.json"),
    JSON.stringify({
      version: 1,
      sourceRunHash: contentHash(raw),
      comparable,
      match,
      apiCalls: 0,
    }),
    { flag: "wx" },
  );
  if (!match) {
    replay.status = "error";
    replay.stopReason =
      "replay differs from recorded outcome or candidate hashes";
    await atomicWriteFile(
      resolve(output, "run.json"),
      JSON.stringify({ ...replay, checksum: contentHash(replay) }),
    );
  }
  return replay;
}
