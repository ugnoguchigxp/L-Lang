import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { generatePredicate } from "./generator";
import { parsePredicateDefinition, type PredicateDefinition } from "./ir";
import {
  callOpenAI,
  DEFAULT_OPENAI_MODEL,
  parseElaborationResult,
  parseOpenAIResponse,
  resolveOpenAIConnection,
  type OpenAIConnection,
  type OpenAIResult,
} from "./openai";

type HarnessConfig = {
  version: 1;
  caseName: string;
  specificationFile: string;
  typeScriptFile: string;
  target: Omit<PredicateDefinition, "version" | "body">;
  outputs: {
    irFile: string;
    codeFile: string;
    reportFile: string;
  };
};

type RunStatus = "passed" | "failed" | "unresolved";
type RunProvider = "fixture" | OpenAIConnection["provider"];

async function main(): Promise<void> {
  const [configPath, ...options] = Bun.argv.slice(2);
  if (configPath === undefined) {
    throw new Error(
      "Usage: bun run src/llm-harness.ts <harness.json> [--fixture <response.json>]",
    );
  }

  const fixturePath = readOptionalOption(options, "--fixture");
  await runHarness(resolve(configPath), fixturePath && resolve(fixturePath));
}

async function runHarness(
  configPath: string,
  fixturePath: string | undefined,
): Promise<void> {
  const configDirectory = dirname(configPath);
  const config = parseHarnessConfig(
    JSON.parse(await readFile(configPath, "utf8")) as unknown,
  );
  const specification = await readFile(
    resolve(configDirectory, config.specificationFile),
    "utf8",
  );
  const typeScriptSource = await readFile(
    resolve(configDirectory, config.typeScriptFile),
    "utf8",
  );
  const reportPath = resolve(configDirectory, config.outputs.reportFile);
  const startedAt = Date.now();
  let stage = "elaboration";
  let openAIResult: OpenAIResult | null = null;
  let status: RunStatus = "failed";
  let provider: RunProvider = fixturePath ? "fixture" : "openai";

  try {
    const model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    console.log(`elaborating ${config.caseName} with ${model}`);

    if (fixturePath) {
      openAIResult = parseOpenAIResponse(
        JSON.parse(await readFile(fixturePath, "utf8")) as unknown,
      );
    } else {
      const connection = resolveOpenAIConnection({
        apiKey: requireEnvironment("OPENAI_API_KEY"),
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      });
      provider = connection.provider;
      openAIResult = await callOpenAI(
          {
            model,
            specification,
            typeScriptSource,
            target: {
              functionName: config.target.name,
              parameterName: config.target.input.parameter,
              typeName: config.target.input.type,
            },
          },
          connection,
        );
    }

    const elaboration = parseElaborationResult(
      JSON.parse(openAIResult.outputText) as unknown,
    );

    if (elaboration.outcome === "unresolved") {
      status = "unresolved";
      throw new Error(
        `specification was unresolved: ${elaboration.diagnostics.join("; ")}`,
      );
    }

    stage = "generation";
    const definition = parsePredicateDefinition({
      version: 1,
      ...config.target,
      body: elaboration.body,
    });
    const irText = `${JSON.stringify(definition, null, 2)}\n`;
    const codeText = generatePredicate(definition);
    const irPath = resolve(configDirectory, config.outputs.irFile);
    const codePath = resolve(configDirectory, config.outputs.codeFile);

    await writeText(irPath, irText);
    await writeText(codePath, codeText);
    console.log(`generated ${relative(process.cwd(), irPath)}`);
    console.log(`generated ${relative(process.cwd(), codePath)}`);

    stage = "typecheck";
    await run(["bun", "run", "typecheck"], stage);
    stage = "test";
    await run(["bun", "test"], stage);
    status = "passed";

    await writeReport(reportPath, {
      config,
      provider,
      openAIResult,
      status,
      stage: "complete",
      startedAt,
      artifacts: {
        irSha256: sha256(irText),
        codeSha256: sha256(codeText),
      },
    });
    console.log(`LLM verification passed; report: ${relative(process.cwd(), reportPath)}`);
  } catch (error) {
    await writeReport(reportPath, {
      config,
      provider,
      openAIResult,
      status,
      stage,
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function parseHarnessConfig(input: unknown): HarnessConfig {
  const value = expectRecord(input, "harness");
  if (value.version !== 1) {
    throw new Error("harness.version must be 1");
  }

  const target = expectRecord(value.target, "harness.target");
  const targetInput = expectRecord(target.input, "harness.target.input");
  const outputs = expectRecord(value.outputs, "harness.outputs");

  if (target.returns !== "boolean") {
    throw new Error('harness.target.returns must be "boolean"');
  }

  return {
    version: 1,
    caseName: expectString(value.caseName, "harness.caseName"),
    specificationFile: expectString(
      value.specificationFile,
      "harness.specificationFile",
    ),
    typeScriptFile: expectString(value.typeScriptFile, "harness.typeScriptFile"),
    target: {
      name: expectString(target.name, "harness.target.name"),
      description: expectString(
        target.description,
        "harness.target.description",
      ),
      input: {
        parameter: expectString(
          targetInput.parameter,
          "harness.target.input.parameter",
        ),
        type: expectString(targetInput.type, "harness.target.input.type"),
        module: expectString(targetInput.module, "harness.target.input.module"),
      },
      returns: "boolean",
    },
    outputs: {
      irFile: expectString(outputs.irFile, "harness.outputs.irFile"),
      codeFile: expectString(outputs.codeFile, "harness.outputs.codeFile"),
      reportFile: expectString(outputs.reportFile, "harness.outputs.reportFile"),
    },
  };
}

async function writeReport(
  path: string,
  input: {
    config: HarnessConfig;
    provider: RunProvider;
    openAIResult: OpenAIResult | null;
    status: RunStatus;
    stage: string;
    startedAt: number;
    artifacts?: { irSha256: string; codeSha256: string };
    error?: string;
  },
): Promise<void> {
  const report = {
    version: 1,
    caseName: input.config.caseName,
    status: input.status,
    failedStage: input.status === "passed" ? null : input.stage,
    provider: input.provider,
    response: input.openAIResult
      ? {
          id: input.openAIResult.responseId,
          model: input.openAIResult.model,
          usage: input.openAIResult.usage,
        }
      : null,
    artifacts: input.artifacts ?? null,
    error: input.error ?? null,
    durationMs: Date.now() - input.startedAt,
    completedAt: new Date().toISOString(),
  };

  await writeText(path, `${JSON.stringify(report, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function run(command: string[], label: string): Promise<void> {
  console.log(`running ${label}`);
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }
}

function readOptionalOption(options: string[], name: string): string | undefined {
  const index = options.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  const value = options[index + 1];
  if (value === undefined) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is required. Copy .env.example to .env and set the value.`,
    );
  }

  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }

  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`llm-harness: ${message}`);
  process.exitCode = 1;
});
