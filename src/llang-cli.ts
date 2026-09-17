import { withSourceWriteLock } from "./source-write-lock";
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
import { buildModuleProgram } from "./llang-module-build";
import { loadModuleProgram } from "./llang-module-loader";
import { testModuleProgram, verifyModuleBundle } from "./llang-module-suite";
import { buildValueModuleProgram } from "./llang-module-value-build";
import { loadValueModuleProgram } from "./llang-module-value-loader";
import {
  testValueModuleProgram,
  verifyValueModuleBundle,
} from "./llang-module-value-suite";
import { buildCollectionModuleProgram } from "./llang-module-collection-build";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import {
  testCollectionModuleProgram,
  verifyCollectionModuleBundle,
} from "./llang-module-collection-suite";

type CliResult = { exitCode: number; output: unknown };

export const LLANG_HELP = `usage: llang <command> [arguments]
  lint <source.llang.jsonc> [--json] [--warnings-as-errors]
  format <source.llang.jsonc> --check|--write
  build <source.llang.jsonc> --out-dir <directory>
  test <source.llang.jsonc> --request <request.json> --suite <tests.json>
  package <source.llang.jsonc> --request <request.json> --suite <tests.json> --metadata <metadata.json> --out-dir <new-directory>
  verify <capability.json>
  mutation-check <source.llang.jsonc> --request <request.json> --suite <tests.json>
  migrate <prompt.json> --out <source.llang.jsonc>
  develop <request.json> --suite <tests.json> --metadata <metadata.json> --fixtures <fixture.json>|--agent codex-sdk --out-dir <new-directory> [--max-output-tokens N] [--max-total-tokens N] [--max-wall-ms N]
  replay-development <run-directory> --out-dir <new-directory>
  module lint <entry.ts|entry.llang.jsonc> --root <directory> --entry <export> [--profile module-bool-v1|module-value-v1|module-collection-v1]
  module build <entry.ts|entry.llang.jsonc> --root <directory> --entry <export> --target typescript|jsonc|wasm|all --out-dir <new-directory> [--profile module-bool-v1|module-value-v1|module-collection-v1]
  module test <entry.ts|entry.llang.jsonc> --root <directory> --entry <export> --suite <cases.json> [--profile module-bool-v1|module-value-v1|module-collection-v1]
  module verify <module-build.json> --suite <cases.json>
Global: --help, --json (machine-readable errors and results)
Exit codes: 0 success; 1 validation/test failure; 2 usage, I/O or execution error.
TypeScript sources: bun run hybrid -- see examples/source-output-matrix/README.md`;

function usage(): never {
  throw Object.assign(new Error(LLANG_HELP), { code: "INVALID_ARGUMENT" });
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
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help"))
    return { exitCode: 0, output: LLANG_HELP };
  if (
    args.length === 2 &&
    args[1] === "--help" &&
    [
      "lint",
      "format",
      "build",
      "test",
      "package",
      "verify",
      "mutation-check",
      "migrate",
      "develop",
      "replay-development",
    ].includes(args[0] ?? "")
  )
    return { exitCode: 0, output: LLANG_HELP };
  if (args[0] === "module") {
    if (args[1] === "--help" || args[1] === "help")
      return { exitCode: 0, output: LLANG_HELP };
    if (args.length === 3 && args[2] === "--help")
      return { exitCode: 0, output: LLANG_HELP };
    const [subcommand, source, ...rawOptions] = args.slice(1);
    if (!subcommand || !source || rawOptions.length % 2) usage();
    const options: Record<string, string> = {};
    for (let index = 0; index < rawOptions.length; index += 2) {
      const key = rawOptions[index] as string,
        value = rawOptions[index + 1] as string;
      if (!key.startsWith("--") || !value || Object.hasOwn(options, key))
        usage();
      options[key] = value;
    }
    if (subcommand === "verify") {
      if (Object.keys(options).join() !== "--suite") usage();
      const manifest = (await readRegularJson(source)) as Record<
        string,
        unknown
      >;
      const report =
        manifest.version === 3 && manifest.profile === "module-collection-v1"
          ? await verifyCollectionModuleBundle(
              source,
              options["--suite"] as string,
            )
          : manifest.version === 2 && manifest.profile === "module-value-v1"
            ? await verifyValueModuleBundle(
                source,
                options["--suite"] as string,
              )
            : await verifyModuleBundle(source, options["--suite"] as string);
      return { exitCode: report.ok ? 0 : 1, output: report };
    }
    const root = options["--root"],
      entryName = options["--entry"],
      profile = options["--profile"] ?? "module-bool-v1";
    if (!root || !entryName) usage();
    if (
      profile !== "module-bool-v1" &&
      profile !== "module-value-v1" &&
      profile !== "module-collection-v1"
    )
      usage();
    if (subcommand === "lint") {
      if (
        Object.keys(options).some(
          (key) => !["--root", "--entry", "--profile"].includes(key),
        )
      )
        usage();
      const program =
        profile === "module-collection-v1"
          ? await loadCollectionModuleProgram(source, root, entryName)
          : profile === "module-value-v1"
            ? await loadValueModuleProgram(source, root, entryName)
            : await loadModuleProgram(source, root, entryName);
      return {
        exitCode: 0,
        output: {
          ok: true,
          sourceSetHash: program.sourceSetHash,
          programHash: program.programHash,
          interfaceHash: program.interfaceHash,
          modules: program.modules.length,
          functions: program.functions.length,
        },
      };
    }
    if (subcommand === "build") {
      if (
        Object.keys(options).some(
          (key) =>
            ![
              "--root",
              "--entry",
              "--target",
              "--out-dir",
              "--profile",
            ].includes(key),
        ) ||
        !options["--out-dir"]
      )
        usage();
      const target = options["--target"] ?? "all";
      if (!["typescript", "jsonc", "wasm", "all"].includes(target)) usage();
      return {
        exitCode: 0,
        output:
          profile === "module-collection-v1"
            ? await buildCollectionModuleProgram({
                entry: source,
                root,
                entryName,
                target: target as "typescript" | "jsonc" | "wasm" | "all",
                outDir: options["--out-dir"] as string,
              })
            : profile === "module-value-v1"
              ? await buildValueModuleProgram({
                  entry: source,
                  root,
                  entryName,
                  target: target as "typescript" | "jsonc" | "wasm" | "all",
                  outDir: options["--out-dir"] as string,
                })
              : await buildModuleProgram({
                  entry: source,
                  root,
                  entryName,
                  target: target as "typescript" | "jsonc" | "wasm" | "all",
                  outDir: options["--out-dir"] as string,
                }),
      };
    }
    if (subcommand === "test") {
      if (
        Object.keys(options).some(
          (key) => !["--root", "--entry", "--suite", "--profile"].includes(key),
        ) ||
        !options["--suite"]
      )
        usage();
      const report =
        profile === "module-collection-v1"
          ? await testCollectionModuleProgram({
              entry: source,
              root,
              entryName,
              suite: options["--suite"] as string,
            })
          : profile === "module-value-v1"
            ? await testValueModuleProgram({
                entry: source,
                root,
                entryName,
                suite: options["--suite"] as string,
              })
            : await testModuleProgram({
                entry: source,
                root,
                entryName,
                suite: options["--suite"] as string,
              });
      return { exitCode: report.ok ? 0 : 1, output: report };
    }
    usage();
  }
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
    const perform = async (): Promise<CliResult> => {
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
    };
    return options[0] === "--write"
      ? withSourceWriteLock(path, perform)
      : perform();
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
      exitCode: report.results.some((item) => item.status === "error")
        ? 2
        : failed
          ? 1
          : 0,
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

/** Public process boundary; runLlangCli remains available to callers that handle errors. */
export async function executeLlangCli(args: string[]): Promise<CliResult> {
  const machine = args.includes("--json");
  try {
    const normalized = args.filter((arg) => arg !== "--json");
    if (machine && args[0] === "lint" && !args.includes("--help"))
      normalized.push("--json");
    if (args.filter((arg) => arg === "--json").length > 1) usage();
    const result = await runLlangCli(normalized);
    return machine && typeof result.output === "string"
      ? {
          ...result,
          output: { ok: result.exitCode === 0, message: result.output },
        }
      : result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "EXECUTION_ERROR";
    return {
      exitCode: code.startsWith("LLM") ? 1 : 2,
      output: { ok: false, error: { code, message } },
    };
  }
}

if (import.meta.main) {
  const result = await executeLlangCli(process.argv.slice(2));
  console.log(
    typeof result.output === "string"
      ? result.output
      : JSON.stringify(result.output, null, 2),
  );
  process.exitCode = result.exitCode;
}
