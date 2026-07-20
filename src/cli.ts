import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { generatePredicate } from "./generator";
import { parsePredicateDefinition } from "./ir";

const usage = `Usage:
  bun run semantic generate <definition.json> --out <generated.ts>
  bun run semantic verify   <definition.json> --out <generated.ts>`;

async function main(): Promise<void> {
  const [command, definitionPath, ...options] = Bun.argv.slice(2);

  if (
    (command !== "generate" && command !== "verify") ||
    definitionPath === undefined
  ) {
    throw new Error(usage);
  }

  const outputPath = readOption(options, "--out");
  await generate(definitionPath, outputPath);

  if (command === "verify") {
    await run(["bun", "run", "typecheck"], "typecheck");
    await run(["bun", "test"], "test");
    console.log("verification completed");
  }
}

async function generate(definitionPath: string, outputPath: string): Promise<void> {
  const source = await readFile(resolve(definitionPath), "utf8");
  const input: unknown = JSON.parse(source);
  const definition = parsePredicateDefinition(input);
  const generated = generatePredicate(definition);
  const absoluteOutputPath = resolve(outputPath);

  await mkdir(dirname(absoluteOutputPath), { recursive: true });
  await writeFile(absoluteOutputPath, generated, "utf8");
  console.log(`generated ${relative(process.cwd(), absoluteOutputPath)}`);
}

function readOption(options: string[], name: string): string {
  const index = options.indexOf(name);
  const value = options[index + 1];

  if (index === -1 || value === undefined) {
    throw new Error(`${name} is required\n\n${usage}`);
  }

  return value;
}

async function run(command: string[], label: string): Promise<void> {
  console.log(`running ${label}`);
  const process = Bun.spawn(command, {
    cwd: processCwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }
}

function processCwd(): string {
  return globalThis.process.cwd();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`semantic-ts: ${message}`);
  globalThis.process.exitCode = 1;
});
