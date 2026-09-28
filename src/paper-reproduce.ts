import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { replayDevelopment } from "./capability-development";
import { verifyInventory } from "./paper-evidence";
import { readJson } from "./prompt-source";
import { digest } from "./wasm-contract";

export type ProcessResult = {
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};
export async function runPaperProcess(
  command: string[],
  timeoutMs = 120_000,
): Promise<ProcessResult> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENAI_API_KEY: "", AZURE_OPENAI_API_KEY: "" },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return {
    command,
    exitCode,
    timedOut,
    stdout,
    stderr,
  };
}
export async function reproducePaper(
  inventoryPath: string,
  outDir: string,
  timeoutMs = 120_000,
) {
  const inventory = await verifyInventory(inventoryPath);
  if (inventory.diagnostics.length || inventory.runStatus !== "pass")
    throw new Error("inventory is incomplete or source run did not pass");
  const input = resolve(dirname(inventoryPath), "evidence");
  const output = resolve(outDir);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const steps: Record<string, unknown> = {};
  let status: "pass" | "fail" | "error" = "error";
  try {
    const replayDir = resolve(output, "replay");
    const replay = await replayDevelopment(input, replayDir);
    const check = (await readJson(resolve(replayDir, "replay-check.json"))) as {
      match: boolean;
      apiCalls: number;
    };
    steps.replay = { status: replay.status, check };
    const attempt = `attempt-${replay.attempts.length - 1}`;
    const source = resolve(input, attempt, "source.json");
    const commands = ["build-a", "build-b"].map((name) => [
      process.execPath,
      "run",
      "src/prompt-cli.ts",
      "build",
      source,
      "--out-dir",
      resolve(output, name),
    ]);
    const processResults = [];
    for (const command of commands)
      processResults.push(await runPaperProcess(command, timeoutMs));
    steps.builds = processResults;
    if (processResults.some((r) => r.timedOut || r.exitCode !== 0)) {
      status = processResults.some((r) => r.timedOut) ? "error" : "fail";
      throw new Error("build process failed or timed out");
    }
    const originalPath = resolve(
      input,
      attempt,
      "candidate",
      `${inventory.wasmHash}.wasm`,
    );
    const rebuilt = [
      resolve(replayDir, attempt, "candidate"),
      resolve(output, "build-a"),
      resolve(output, "build-b"),
    ];
    const manifests = await Promise.all(
      rebuilt.map(async (dir) => {
        const manifest = (await readJson(resolve(dir, "manifest.json"))) as {
          file: string;
          wasmHash: string;
        };
        if (!/^[a-f0-9]{64}\.wasm$/.test(manifest.file))
          throw new Error(`invalid rebuilt Wasm filename: ${dir}`);
        return { dir, ...manifest };
      }),
    );
    const paths = [
      originalPath,
      ...manifests.map((manifest) => resolve(manifest.dir, manifest.file)),
    ];
    const bytes = await Promise.all(paths.map((path) => readFile(path)));
    const hashes = bytes.map((b) => digest(b));
    const byteEqual = bytes.every((b) => b.equals(bytes[0] as Buffer));
    steps.comparison = {
      byteEqual,
      bytes: bytes.map((b) => b.length),
      hashes,
      manifestHashes: manifests.map((manifest) => manifest.wasmHash),
      wasmHash: inventory.wasmHash,
      packageHash: inventory.packageHash,
    };
    status =
      replay.status === "pass" &&
      check.match &&
      check.apiCalls === 0 &&
      processResults.every((r) => r.exitCode === 0 && !r.timedOut) &&
      byteEqual &&
      hashes[0] === inventory.wasmHash &&
      manifests.every((manifest, i) => manifest.wasmHash === hashes[i + 1])
        ? "pass"
        : "fail";
  } catch (error) {
    steps.error = error instanceof Error ? error.message : String(error);
  }
  const result = {
    version: 1,
    status,
    inventory: inventoryPath,
    apiCalls: 0,
    steps,
  };
  await writeFile(
    resolve(output, "reproduction.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  return result;
}
