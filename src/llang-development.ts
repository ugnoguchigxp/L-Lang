import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicWriteJson } from "./atomic-file";
import type {
  DevelopmentAgent,
  DevelopmentRequest,
} from "./capability-test-agent";
import { parseAgentReply } from "./capability-test-agent";
import {
  packageLlangCapability,
  parseLlangCapabilityMetadata,
  parseLlangRequest,
  parseLlangSuite,
  verifyLlangCapability,
} from "./llang-capability";
import { checkLlangProgram } from "./llang-program";
import {
  decodeUtf8,
  LLANG_SOURCE_BYTES,
  parseStrictJsonObject,
} from "./llang-jsonc";
import { contentHash } from "./prompt-source";
import { record, WasmError } from "./wasm-contract";

export type LlangDevelopmentConfig = {
  version: 2;
  mode: "fixture" | "live" | "replay";
  model: string;
  maxCalls: 1 | 2;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxWallMs: number;
};
async function readDevelopmentJson(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > LLANG_SOURCE_BYTES)
    throw new WasmError(
      "INVALID_CAPABILITY",
      "development snapshot must be a bounded regular file",
    );
  const bytes = await readFile(path);
  if (bytes.byteLength > LLANG_SOURCE_BYTES)
    throw new WasmError(
      "INVALID_CAPABILITY",
      "development snapshot exceeds size limit",
    );
  return parseStrictJsonObject(decodeUtf8(bytes, path), path);
}

const programSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["generated", "unresolved", "error"] },
    program: {
      anyOf: [{ $ref: "#/$defs/program" }, { type: "null" }],
    },
    diagnostics: {
      type: "array",
      maxItems: 32,
      items: { type: "string", maxLength: 2000 },
    },
  },
  required: ["outcome", "program", "diagnostics"],
  $defs: {
    program: {
      type: "object",
      additionalProperties: false,
      properties: {
        language: { type: "string", enum: ["l-lang"] },
        version: { type: "integer", enum: [1] },
        id: { type: "string" },
        profile: { type: "string", enum: ["predicate-i32-v1"] },
        description: { type: "string" },
        contract: { $ref: "#/$defs/contract" },
        body: { $ref: "#/$defs/expression" },
      },
      required: [
        "language",
        "version",
        "id",
        "profile",
        "description",
        "contract",
        "body",
      ],
    },
    contract: {
      type: "object",
      additionalProperties: false,
      properties: {
        version: { type: "integer", enum: [1] },
        fields: {
          type: "array",
          items: { $ref: "#/$defs/field" },
        },
      },
      required: ["version", "fields"],
    },
    field: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: ["boolean", "enum", "string"] },
        values: { type: "array", items: { type: "string" } },
        nullable: { type: "boolean" },
        undefinable: { type: "boolean" },
        optional: { type: "boolean" },
      },
      required: [
        "name",
        "kind",
        "values",
        "nullable",
        "undefinable",
        "optional",
      ],
    },
    expression: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["all", "any"] },
            conditions: {
              type: "array",
              items: { $ref: "#/$defs/expression" },
            },
          },
          required: ["kind", "conditions"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["not"] },
            condition: { $ref: "#/$defs/expression" },
          },
          required: ["kind", "condition"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["equals"] },
            property: { type: "array", items: { type: "string" } },
            value: {
              anyOf: [
                { type: "string" },
                { type: "boolean" },
                { type: "null" },
              ],
            },
          },
          required: ["kind", "property", "value"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["present"] },
            property: { type: "array", items: { type: "string" } },
          },
          required: ["kind", "property"],
        },
      ],
    },
  },
};

function parseConfig(input: unknown): LlangDevelopmentConfig {
  const value = record(input, [
    "version",
    "mode",
    "model",
    "maxCalls",
    "maxOutputTokens",
    "maxTotalTokens",
    "maxWallMs",
  ]);
  if (
    value.version !== 2 ||
    !["fixture", "live", "replay"].includes(String(value.mode)) ||
    !Number.isSafeInteger(value.maxCalls) ||
    ![1, 2].includes(value.maxCalls as number) ||
    typeof value.model !== "string" ||
    !value.model ||
    value.model.length > 256 ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    Number(value.maxOutputTokens) < 256 ||
    Number(value.maxOutputTokens) > 16384 ||
    !Number.isSafeInteger(value.maxTotalTokens) ||
    Number(value.maxTotalTokens) < 1 ||
    Number(value.maxTotalTokens) > 10_000_000 ||
    !Number.isSafeInteger(value.maxWallMs) ||
    Number(value.maxWallMs) < 1 ||
    Number(value.maxWallMs) > 3_600_000
  )
    throw new WasmError(
      "INVALID_CAPABILITY",
      "invalid L-Lang development config",
    );
  return value as LlangDevelopmentConfig;
}

function requestFor(
  request: unknown,
  previous?: { program: unknown; report: unknown },
): DevelopmentRequest {
  return {
    stage: previous ? "repair" : "implementation",
    instruction: previous
      ? "Repair only the L-Lang Program implementation using the fixed test failures. Do not change the request, contract, or tests. Return outcome, the complete program object, and concise diagnostics."
      : "Create an L-Lang Program from the fixed request and contract. The program must use language l-lang, version 1, profile predicate-i32-v1, and only all/any/not/equals/present predicate IR. Do not change the request or contract. Return outcome, the complete program object, and concise diagnostics.",
    input: previous ? { request, previous } : { request },
    schema: programSchema,
  };
}

function parseProgramResult(input: unknown) {
  const value = record(input, ["outcome", "program", "diagnostics"]);
  if (
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > 32 ||
    value.diagnostics.some(
      (item) => typeof item !== "string" || item.length > 2000,
    )
  )
    throw new WasmError("INVALID_CAPABILITY", "invalid agent diagnostics");
  if (
    value.outcome === "generated" &&
    value.program &&
    typeof value.program === "object"
  )
    return {
      outcome: "generated" as const,
      program: value.program,
      diagnostics: value.diagnostics as string[],
    };
  if (
    (value.outcome === "unresolved" || value.outcome === "error") &&
    value.program === null &&
    value.diagnostics.length
  )
    return {
      outcome: value.outcome,
      program: null,
      diagnostics: value.diagnostics as string[],
    };
  throw new WasmError("INVALID_CAPABILITY", "invalid agent program response");
}

export async function developLlangCapability(
  requestInput: unknown,
  suiteInput: unknown,
  metadata: unknown,
  configInput: unknown,
  agent: DevelopmentAgent,
  outputDirectory: string,
) {
  const request = parseLlangRequest(requestInput);
  const suite = parseLlangSuite(suiteInput, request);
  const parsedMetadata = parseLlangCapabilityMetadata(metadata);
  if (parsedMetadata.id !== request.id)
    throw new WasmError(
      "INVALID_CAPABILITY",
      "metadata id differs from request id",
    );
  const config = parseConfig(configInput);
  const root = resolve(outputDirectory);
  await mkdir(root);
  await writeFile(
    resolve(root, "request.json"),
    `${JSON.stringify(request, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    resolve(root, "tests.json"),
    `${JSON.stringify(suite, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    resolve(root, "metadata.json"),
    `${JSON.stringify(parsedMetadata, null, 2)}\n`,
    { flag: "wx" },
  );
  const run = {
    version: 2,
    protocol: "llang-development-v2",
    complete: false,
    status: "running",
    requestHash: contentHash(request),
    suiteHash: contentHash(suite),
    metadataHash: contentHash(parsedMetadata),
    config,
    apiCalls: 0,
    logicalCalls: 0,
    usedTokens: 0,
    calls: [] as unknown[],
    attempts: [] as unknown[],
    stopReason: null as string | null,
  };
  const started = Date.now();
  const checkpoint = () => {
    const value = {
      ...run,
      checksum: contentHash(run),
    };
    if (Buffer.byteLength(JSON.stringify(value)) > LLANG_SOURCE_BYTES)
      throw new WasmError(
        "INVALID_CAPABILITY",
        "development run exceeds size limit",
      );
    return atomicWriteJson(resolve(root, "run.json"), value);
  };
  const assertFixed = async () => {
    if (
      contentHash(await readDevelopmentJson(resolve(root, "request.json"))) !==
        run.requestHash ||
      contentHash(await readDevelopmentJson(resolve(root, "tests.json"))) !==
        run.suiteHash ||
      contentHash(await readDevelopmentJson(resolve(root, "metadata.json"))) !==
        run.metadataHash
    )
      throw new WasmError(
        "INVALID_CAPABILITY",
        "fixed development inputs changed",
      );
  };
  await checkpoint();
  let previous: { program: unknown; report: unknown } | undefined;
  let previousProgramHash: string | undefined;
  async function callAgent(requestMessage: DevelopmentRequest) {
    const requestHash = contentHash(requestMessage);
    const inputReservation =
      Math.ceil(Buffer.byteLength(JSON.stringify(requestMessage)) / 4) + 2048;
    const reservation = inputReservation + config.maxOutputTokens;
    if (
      config.mode === "live" &&
      run.usedTokens + reservation > config.maxTotalTokens
    )
      throw new WasmError(
        "DEVELOPMENT_LIMIT",
        "insufficient token budget for reserved call",
      );
    const entry: {
      stage: DevelopmentRequest["stage"];
      requestHash: string;
      request: DevelopmentRequest;
      reply: ReturnType<typeof parseAgentReply> | null;
      error: string | null;
    } = {
      stage: requestMessage.stage,
      requestHash,
      request: structuredClone(requestMessage),
      reply: null,
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
        agent(structuredClone(requestMessage), controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(
                new WasmError(
                  "DEVELOPMENT_LIMIT",
                  "agent response deadline exceeded",
                ),
              );
            },
            Math.max(1, config.maxWallMs - (Date.now() - started)),
          );
        }),
      ]);
      if (Buffer.byteLength(JSON.stringify(raw)) > 64 * 1024)
        throw new WasmError(
          "INVALID_CAPABILITY",
          "agent response exceeds 64 KiB",
        );
      const reply = parseAgentReply(raw);
      entry.reply = reply;
      if (config.mode === "live") {
        if (!reply.usage)
          throw new WasmError("DEVELOPMENT_LIMIT", "live usage missing");
        run.usedTokens += reply.usage.totalTokens;
        if (
          reply.usage.inputTokens > inputReservation ||
          reply.usage.outputTokens > config.maxOutputTokens ||
          run.usedTokens > config.maxTotalTokens
        )
          throw new WasmError("DEVELOPMENT_LIMIT", "token budget exceeded");
      }
      await assertFixed();
      return reply;
    } catch (error) {
      entry.error = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 4096);
      if (config.mode === "live" && !entry.reply) run.usedTokens += reservation;
      throw error;
    } finally {
      controller.abort();
      if (timer) clearTimeout(timer);
      await checkpoint();
    }
  }
  try {
    for (let index = 0; index < config.maxCalls; index++) {
      await assertFixed();
      if (Date.now() - started >= config.maxWallMs)
        throw new WasmError("DEVELOPMENT_LIMIT", "wall-clock limit reached");
      const requestMessage = requestFor(request, previous);
      const reply = await callAgent(requestMessage);
      const result = parseProgramResult(reply.result);
      if (result.outcome !== "generated") {
        run.status = result.outcome;
        run.stopReason = result.diagnostics.join("; ");
        break;
      }
      const source = `// Generated candidate; request and tests are immutable external evidence.\n${JSON.stringify(result.program, null, 2)}\n`;
      const submittedProgramHash = contentHash(result.program);
      if (previousProgramHash === submittedProgramHash) {
        run.status = "stopped";
        run.stopReason = "same Program resubmitted";
        break;
      }
      previousProgramHash = submittedProgramHash;
      const checked = checkLlangProgram(
        source,
        `attempt-${index}.llang.jsonc`,
      ).checked;
      const attempt = resolve(root, `attempt-${index}`);
      await mkdir(attempt);
      const sourcePath = resolve(attempt, `${request.id}.llang.jsonc`);
      await writeFile(sourcePath, source, { flag: "wx" });
      let report: unknown;
      if (
        !checked ||
        checked.program.id !== request.id ||
        contentHash(checked.program.contract) !== contentHash(request.contract)
      ) {
        report = {
          status: "error",
          diagnostics: checked
            ? ["candidate changed the fixed id or contract"]
            : checkLlangProgram(source, `attempt-${index}.llang.jsonc`).report
                .diagnostics,
        };
      } else {
        try {
          const candidate = await packageLlangCapability(
            sourcePath,
            resolve(root, "request.json"),
            resolve(root, "tests.json"),
            parsedMetadata,
            resolve(attempt, "candidate"),
          );
          report = await verifyLlangCapability(candidate.manifest);
        } catch (error) {
          report = {
            status: "error",
            diagnostics: [
              (error instanceof Error ? error.message : String(error)).slice(
                0,
                4096,
              ),
            ],
          };
        }
      }
      const status = String((report as { status: string }).status);
      run.attempts.push({
        index,
        programHash: checked?.programHash ?? null,
        status,
        reportHash: contentHash(report),
      });
      await atomicWriteJson(resolve(attempt, "report.json"), report);
      await checkpoint();
      if (status === "pass" || index + 1 === config.maxCalls) {
        run.status = status;
        run.stopReason =
          status === "pass"
            ? null
            : "candidate did not pass within the allowed attempts";
        break;
      }
      previous = { program: result.program, report };
    }
  } catch (error) {
    run.status =
      error instanceof WasmError && error.code === "DEVELOPMENT_LIMIT"
        ? "stopped"
        : "error";
    run.stopReason = error instanceof Error ? error.message : String(error);
  }
  run.complete = true;
  await checkpoint();
  return run;
}

export function fixtureLlangAgent(input: unknown): DevelopmentAgent {
  const value = record(input, ["version", "responses"]);
  if (
    value.version !== 2 ||
    !Array.isArray(value.responses) ||
    value.responses.length > 2
  )
    throw new WasmError("INVALID_CAPABILITY", "invalid L-Lang fixture");
  const responses = value.responses as unknown[];
  let index = 0;
  return async (request) => {
    const item = record(responses[index++], ["stage", "reply"]);
    if (item.stage !== request.stage)
      throw new WasmError("INVALID_CAPABILITY", "fixture stage mismatch");
    return parseAgentReply(item.reply);
  };
}

export async function replayLlangDevelopment(
  directory: string,
  output: string,
) {
  const root = resolve(directory);
  async function readSnapshot(name: string) {
    const path = resolve(root, name);
    return readDevelopmentJson(path);
  }
  const persisted = record(await readSnapshot("run.json"), [
    "version",
    "protocol",
    "complete",
    "status",
    "requestHash",
    "suiteHash",
    "metadataHash",
    "config",
    "apiCalls",
    "logicalCalls",
    "usedTokens",
    "calls",
    "attempts",
    "stopReason",
    "checksum",
  ]);
  const { checksum, ...raw } = persisted;
  if (
    raw.version !== 2 ||
    raw.protocol !== "llang-development-v2" ||
    !raw.complete ||
    checksum !== contentHash(raw) ||
    !Array.isArray(raw.calls) ||
    raw.calls.length > 2 ||
    raw.logicalCalls !== raw.calls.length ||
    !Array.isArray(raw.attempts) ||
    raw.attempts.length > 2
  )
    throw new WasmError("INVALID_CAPABILITY", "invalid development run");
  const originalConfig = parseConfig(raw.config);
  if (
    !["pass", "fail", "error", "unresolved", "stopped"].includes(
      String(raw.status),
    ) ||
    typeof raw.requestHash !== "string" ||
    typeof raw.suiteHash !== "string" ||
    typeof raw.metadataHash !== "string" ||
    raw.apiCalls !== (originalConfig.mode === "live" ? raw.calls.length : 0) ||
    !Number.isSafeInteger(raw.usedTokens) ||
    Number(raw.usedTokens) < 0 ||
    (raw.stopReason !== null && typeof raw.stopReason !== "string")
  )
    throw new WasmError("INVALID_CAPABILITY", "invalid development status");
  const calls = raw.calls.map((input: unknown, callIndex: number) => {
    const call = record(input, [
      "stage",
      "requestHash",
      "request",
      "reply",
      "error",
    ]);
    if (
      call.stage !== (callIndex === 0 ? "implementation" : "repair") ||
      call.requestHash !== contentHash(call.request) ||
      (call.error !== null && typeof call.error !== "string") ||
      (call.reply === null && call.error === null)
    )
      throw new WasmError("INVALID_CAPABILITY", "invalid recorded call");
    const reply = call.reply === null ? null : parseAgentReply(call.reply);
    return {
      stage: call.stage,
      requestHash: String(call.requestHash),
      request: call.request,
      reply,
      error: call.error === null ? null : String(call.error),
    };
  });
  raw.attempts.forEach((input: unknown, attemptIndex: number) => {
    const attempt = record(input, [
      "index",
      "programHash",
      "status",
      "reportHash",
    ]);
    if (
      attempt.index !== attemptIndex ||
      !["pass", "fail", "error"].includes(String(attempt.status)) ||
      (attempt.programHash !== null &&
        (typeof attempt.programHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(attempt.programHash))) ||
      typeof attempt.reportHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(attempt.reportHash)
    )
      throw new WasmError("INVALID_CAPABILITY", "invalid recorded attempt");
  });
  const requestSnapshot = await readSnapshot("request.json");
  const suiteSnapshot = await readSnapshot("tests.json");
  const metadataSnapshot = await readSnapshot("metadata.json");
  if (
    contentHash(requestSnapshot) !== raw.requestHash ||
    contentHash(suiteSnapshot) !== raw.suiteHash ||
    contentHash(metadataSnapshot) !== raw.metadataHash
  )
    throw new WasmError(
      "INVALID_CAPABILITY",
      "development snapshot hash mismatch",
    );
  let index = 0;
  const replay = await developLlangCapability(
    requestSnapshot,
    suiteSnapshot,
    metadataSnapshot,
    { ...originalConfig, mode: "replay" },
    async (request) => {
      const call = calls[index++];
      if (!call || call.requestHash !== contentHash(request))
        throw new WasmError("INVALID_CAPABILITY", "replay request mismatch");
      if (call.error !== null) {
        const message = String(call.error);
        if (message.startsWith("DEVELOPMENT_LIMIT:"))
          throw new WasmError("DEVELOPMENT_LIMIT", message);
        throw new Error(message);
      }
      if (call.reply === null)
        throw new WasmError("INVALID_CAPABILITY", "recorded reply is missing");
      return call.reply;
    },
    output,
  );
  const match =
    index === calls.length &&
    replay.status === raw.status &&
    contentHash(replay.attempts) === contentHash(raw.attempts);
  await atomicWriteJson(resolve(output, "replay-check.json"), {
    version: 2,
    match,
    apiCalls: 0,
    sourceRunHash: contentHash(raw),
  });
  if (!match)
    throw new WasmError(
      "INVALID_CAPABILITY",
      "replay differs from recorded run",
    );
  return replay;
}
