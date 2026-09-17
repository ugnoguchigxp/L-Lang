import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicWriteText } from "./atomic-file";
import { buildLlangProgram } from "./llang-build";
import {
  packageLlangCapability,
  checkLlangMutations,
  runLlangSuite,
  verifyLlangCapability,
} from "./llang-capability";
import type { LlangDiagnosticReport } from "./llang-diagnostics";
import {
  LLANG_SOURCE_BYTES,
  decodeUtf8,
  formatLlangJsonc,
  parseStrictJsonObject,
} from "./llang-jsonc";
import { checkLlangProgram } from "./llang-program";
import { migratePromptSource } from "./llang-migrate";
import {
  developLlangCapability,
  fixtureLlangAgent,
  replayLlangDevelopment,
} from "./llang-development";

type CliResult = { exitCode: number; output: unknown };

function usage(): never {
  throw new Error(
    "usage: llang lint|format|build|test|package|verify|migrate|develop|replay-development (see docs/LLANG_JSONC_SPEC.md)",
  );
}

async function readSource(path: string) {
  const absolute = resolve(path);
  if (!absolute.endsWith(".llang.jsonc"))
    throw new Error("source must use .llang.jsonc");
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("source must be a regular non-symlink file");
  if (info.size > LLANG_SOURCE_BYTES)
    throw new Error(`source exceeds ${LLANG_SOURCE_BYTES} bytes`);
  return { absolute, text: decodeUtf8(await readFile(absolute), absolute) };
}

async function readRegularJson(path: string) {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("JSON input must be a regular non-symlink file");
  if (info.size > LLANG_SOURCE_BYTES)
    throw new Error(`JSON input exceeds ${LLANG_SOURCE_BYTES} bytes`);
  const bytes = await readFile(absolute);
  if (bytes.byteLength > LLANG_SOURCE_BYTES)
    throw new Error(`JSON input exceeds ${LLANG_SOURCE_BYTES} bytes`);
  return parseStrictJsonObject(decodeUtf8(bytes, absolute), absolute);
}

function textReport(report: LlangDiagnosticReport): string {
  if (!report.diagnostics.length) return "OK";
  const lines = report.diagnostics.map((item) => {
    const location = `${item.file}:${item.range.start.line}:${item.range.start.column}`;
    const hint = item.hint ? `\n  hint: ${item.hint}` : "";
    return `${location} ${item.severity} ${item.code} ${item.path || "/"}: ${item.message}${hint}`;
  });
  if (report.truncated) lines.push("additional diagnostics were truncated");
  return lines.join("\n");
}

export async function runLlangCli(args: string[]): Promise<CliResult> {
  const [command, path, ...options] = args;
  if (!command || !path) usage();
  if (command === "lint") {
    const allowed = new Set(["--json", "--warnings-as-errors"]);
    if (
      options.some((option) => !allowed.has(option)) ||
      new Set(options).size !== options.length
    )
      usage();
    const source = await readSource(path);
    const { report, checked } = checkLlangProgram(source.text, source.absolute);
    const ok =
      report.ok &&
      (!options.includes("--warnings-as-errors") ||
        !report.diagnostics.some((item) => item.severity === "warning"));
    return {
      exitCode: ok ? 0 : 1,
      output: options.includes("--json")
        ? {
            ...report,
            ok,
            ...(checked
              ? {
                  sourceHash: checked.sourceHash,
                  programHash: checked.programHash,
                }
              : {}),
          }
        : textReport(report),
    };
  }
  if (command === "format") {
    if (
      options.length !== 1 ||
      (options[0] !== "--check" && options[0] !== "--write")
    )
      usage();
    const source = await readSource(path);
    const formatted = formatLlangJsonc(source.text, source.absolute);
    if (!formatted.report.ok)
      return { exitCode: 1, output: textReport(formatted.report) };
    const changed = formatted.text !== source.text;
    if (options[0] === "--write" && changed) {
      const current = await readSource(path);
      if (current.text !== source.text)
        throw new Error("source changed during format");
      await atomicWriteText(source.absolute, formatted.text);
    }
    return {
      exitCode: options[0] === "--check" && changed ? 1 : 0,
      output: { changed, written: options[0] === "--write" && changed },
    };
  }
  if (command === "build") {
    if (options.length !== 2 || options[0] !== "--out-dir" || !options[1])
      usage();
    return {
      exitCode: 0,
      output: await buildLlangProgram(path, options[1]),
    };
  }
  if (command === "test") {
    if (
      options.length !== 4 ||
      options[0] !== "--request" ||
      options[2] !== "--suite"
    )
      usage();
    const report = await runLlangSuite(
      path,
      options[1] as string,
      options[3] as string,
    );
    const failed =
      report.results.filter((item) => item.status !== "pass").length +
      report.uncoveredRequirements.length;
    return {
      exitCode: failed ? 1 : 0,
      output: { ...report, ok: failed === 0 },
    };
  }
  if (command === "package") {
    if (
      options.length !== 8 ||
      options[0] !== "--request" ||
      options[2] !== "--suite" ||
      options[4] !== "--metadata" ||
      options[6] !== "--out-dir"
    )
      usage();
    const metadata = await readRegularJson(options[5] as string);
    return {
      exitCode: 0,
      output: await packageLlangCapability(
        path,
        options[1] as string,
        options[3] as string,
        metadata,
        options[7] as string,
      ),
    };
  }
  if (command === "verify") {
    if (options.length) usage();
    const report = await verifyLlangCapability(path);
    return {
      exitCode: report.status === "pass" ? 0 : report.status === "fail" ? 1 : 2,
      output: report,
    };
  }
  if (command === "mutation-check") {
    if (
      options.length !== 4 ||
      options[0] !== "--request" ||
      options[2] !== "--suite"
    )
      usage();
    const report = await checkLlangMutations(
      path,
      options[1] as string,
      options[3] as string,
    );
    return {
      exitCode:
        report.uncoveredRequirements.length ||
        report.omittedProposals ||
        report.mutations.some((item) =>
          ["survived", "unknown"].includes(item.status),
        )
          ? 1
          : 0,
      output: report,
    };
  }
  if (command === "migrate") {
    if (options.length !== 2 || options[0] !== "--out") usage();
    return {
      exitCode: 0,
      output: await migratePromptSource(path, options[1] as string),
    };
  }
  if (command === "develop") {
    const allowed = new Set([
      "--suite",
      "--metadata",
      "--fixtures",
      "--out-dir",
      "--agent",
      "--max-output-tokens",
      "--max-total-tokens",
      "--max-wall-ms",
    ]);
    if (options.length % 2) usage();
    const parsed: Record<string, string> = {};
    for (let index = 0; index < options.length; index += 2) {
      const key = options[index] as string,
        value = options[index + 1] as string;
      if (!allowed.has(key) || !value || Object.hasOwn(parsed, key)) usage();
      parsed[key] = value;
    }
    for (const key of ["--suite", "--metadata", "--out-dir"])
      if (!parsed[key]) usage();
    const live = parsed["--agent"] === "codex-sdk";
    if (
      (!live && !parsed["--fixtures"]) ||
      (live && parsed["--fixtures"]) ||
      (parsed["--agent"] && !live)
    )
      usage();
    const config = {
      version: 2 as const,
      mode: live ? ("live" as const) : ("fixture" as const),
      model: live ? "gpt-5.6-terra" : "fixture",
      maxCalls: 2 as const,
      maxOutputTokens: Number(parsed["--max-output-tokens"] ?? 4096),
      maxTotalTokens: Number(parsed["--max-total-tokens"] ?? 100000),
      maxWallMs: Number(parsed["--max-wall-ms"] ?? 120000),
    };
    const agent = live
      ? (await import("./codex-development-agent")).makeCodexDevelopmentAgent()
      : fixtureLlangAgent(
          await readRegularJson(parsed["--fixtures"] as string),
        );
    const result = await developLlangCapability(
      await readRegularJson(path),
      await readRegularJson(parsed["--suite"] as string),
      await readRegularJson(parsed["--metadata"] as string),
      config,
      agent,
      parsed["--out-dir"] as string,
    );
    return {
      exitCode: result.status === "pass" ? 0 : result.status === "fail" ? 1 : 2,
      output: result,
    };
  }
  if (command === "replay-development") {
    if (options.length !== 2 || options[0] !== "--out-dir") usage();
    const result = await replayLlangDevelopment(path, options[1] as string);
    return {
      exitCode: result.status === "pass" ? 0 : result.status === "fail" ? 1 : 2,
      output: result,
    };
  }
  return usage();
}

if (import.meta.main) {
  try {
    const result = await runLlangCli(process.argv.slice(2));
    console.log(
      typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output, null, 2),
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
