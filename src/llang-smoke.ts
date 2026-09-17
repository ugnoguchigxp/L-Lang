import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = await mkdtemp(resolve(tmpdir(), "llang-smoke-"));
const base = resolve("examples/jsonc-enabled-user");
const source = resolve(base, "enabled-user.llang.jsonc");
const request = resolve(base, "request.json"),
  suite = resolve(base, "tests.json");
let checks = 0;
async function cli(args: string[], expected = 0) {
  const child = Bun.spawn(
    [process.execPath, resolve("src/llang-cli.ts"), ...args, "--json"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENAI_API_KEY: "", AZURE_OPENAI_API_KEY: "" },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== expected)
    throw new Error(`${args[0]} returned ${code}: ${stdout}\n${stderr}`);
  const result = JSON.parse(stdout);
  checks++;
  return result;
}
try {
  await cli(["--help"]);
  await cli(["unknown", "input"], 2);
  const original = await readFile(source, "utf8");
  await cli(["lint", source]);
  const formatted = resolve(root, "format.llang.jsonc");
  await cp(source, formatted);
  await cli(["format", formatted, "--write"]);
  await cli(["format", formatted, "--check"]);
  await cli(["mutation-check", source, "--request", request, "--suite", suite]);
  await cli(["build", source, "--out-dir", resolve(root, "build")]);
  const tested = await cli([
    "test",
    source,
    "--request",
    request,
    "--suite",
    suite,
  ]);
  const packaged = await cli([
    "package",
    source,
    "--request",
    request,
    "--suite",
    suite,
    "--metadata",
    resolve(base, "metadata.json"),
    "--out-dir",
    resolve(root, "package"),
  ]);
  await cp(resolve(root, "package"), resolve(root, "moved"), {
    recursive: true,
  });
  await rm(resolve(root, "package"), { recursive: true });
  const verified = await cli([
    "verify",
    resolve(root, "moved/capability.json"),
  ]);
  if (
    verified.packageHash !== packaged.packageHash ||
    verified.status !== "pass"
  )
    throw new Error("moved package mismatch");
  for (const key of [
    "requestRevision",
    "suiteHash",
    "sourceHash",
    "programHash",
    "artifactHash",
  ])
    if (tested[key] !== verified[key])
      throw new Error(`provenance mismatch: ${key}`);
  await cli([
    "develop",
    request,
    "--suite",
    suite,
    "--metadata",
    resolve(base, "metadata.json"),
    "--fixtures",
    resolve(base, "development.fixture.json"),
    "--out-dir",
    resolve(root, "development"),
  ]);
  await cli([
    "replay-development",
    resolve(root, "development"),
    "--out-dir",
    resolve(root, "replay"),
  ]);
  const recorded = JSON.parse(
    await readFile(resolve(root, "development/run.json"), "utf8"),
  );
  if (recorded.status !== "pass") throw new Error("fixture did not pass");
  if ((await readFile(source, "utf8")) !== original)
    throw new Error("smoke modified the example");
  console.log(
    JSON.stringify({ status: "pass", checks, apiCalls: 0, bun: Bun.version }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
