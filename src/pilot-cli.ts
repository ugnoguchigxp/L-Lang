import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertPilotFrozen,
  readPilotProtocol,
  writePilotFreeze,
} from "./pilot-manifest";
import {
  callOpenAI,
  DEFAULT_OPENAI_MODEL,
  resolveOpenAIConnection,
} from "./openai";
import { runPilotLive } from "./pilot-live";
import { renderPilotReport, type PilotReport } from "./pilot-report";
import { runPilotFixture } from "./pilot-runner";
import { parseBoundedJsonText } from "./semantic-limits";

const [command, target, ...flags] = process.argv.slice(2);

if (command === "run" && target !== undefined) {
  const fixture = flags.includes("--fixture");
  const live = flags.includes("--live");
  if (fixture === live) {
    throw new Error("pilot run requires exactly one of --fixture or --live");
  }
  if (live) {
    const manifestPath = resolve(target);
    const protocol = await readPilotProtocol(manifestPath);
    assertPilotFrozen(protocol.freeze);
    const result = await runLive(manifestPath);
    console.log(
      [
        `pilot ${result.report.status}`,
        `pilot: ${result.report.pilot}`,
        `first-pass fit: ${result.report.summary.firstPassProjectFit}/${result.report.summary.total}`,
        `false resolutions: ${result.report.summary.falseResolutions}`,
        `API attempts: ${result.report.executionMetrics.apiAttempts}`,
        `cooldowns: ${result.report.executionMetrics.cooldownCompletions}`,
        `estimated cost: ${result.report.executionMetrics.estimatedCost}`,
        `report: ${result.reportDirectory}`,
      ].join("\n"),
    );
    if (result.report.status !== "passed") {
      process.exitCode = 2;
    }
  } else {
    const result = await runPilotFixture({ manifestPath: resolve(target) });
    console.log(
      [
        `pilot ${result.report.status}`,
        `pilot: ${result.report.pilot}`,
        `first-pass fit: ${result.report.summary.firstPassProjectFit}/${result.report.summary.total}`,
        `false resolutions: ${result.report.summary.falseResolutions}`,
        `business writes: ${result.report.safety.businessWrites}`,
        `external I/O: ${result.report.safety.externalIo}`,
        `report: ${result.reportDirectory}`,
      ].join("\n"),
    );
    if (result.report.status !== "fixture-passed") {
      process.exitCode = 2;
    }
  }
} else if (command === "freeze" && target !== undefined) {
  const requestedStatus = flags.includes("--frozen") ? "frozen" : "draft";
  const result = await writePilotFreeze({
    manifestPath: resolve(target),
    status: requestedStatus,
  });
  console.log(
    [
      `pilot freeze ${requestedStatus}`,
      `files: ${Object.keys(result.files).length}`,
      `path: ${result.path}`,
    ].join("\n"),
  );
} else if (command === "report" && target !== undefined) {
  const input = parseBoundedJsonText(
    await readFile(resolve(target), "utf8"),
    "Pilot report",
  ) as PilotReport;
  const output = flags[0] ?? target.replace(/\.json$/u, ".md");
  await writeFile(resolve(output), renderPilotReport(input), "utf8");
  console.log(`pilot report: ${resolve(output)}`);
} else {
  throw new Error(
    [
      "usage:",
      "  bun run pilot:run <manifest.json> --fixture",
      "  bun run pilot:run <manifest.json> --live",
      "  bun run pilot:freeze <manifest.json> [--frozen]",
      "  bun run pilot:report <report.json> [report.md]",
    ].join("\n"),
  );
}

async function runLive(manifestPath: string) {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (apiKey.length === 0) {
    throw new Error("OPENAI_API_KEY is required for the frozen Pilot");
  }
  const connection = resolveOpenAIConnection({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  });
  return runPilotLive({
    manifestPath,
    model: process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
    provider: connection.provider,
    costPerMillionTokens: {
      input: tokenRate("OPENAI_INPUT_COST_PER_MILLION_TOKENS"),
      output: tokenRate("OPENAI_OUTPUT_COST_PER_MILLION_TOKENS"),
    },
    resolve: (input) => callOpenAI(input, connection),
    cooldownMs: 60_000,
    maxRateLimitRetries: 5,
    ...(process.env.PILOT_RUN_ID === undefined
      ? {}
      : { runId: process.env.PILOT_RUN_ID }),
    onProgress: (message) => console.log(message),
  });
}

function tokenRate(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${name} must be set to a non-negative USD cost per million tokens`,
    );
  }
  return value;
}
