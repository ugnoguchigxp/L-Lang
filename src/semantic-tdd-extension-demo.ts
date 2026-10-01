import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export async function runTddExtensionDemo(
  outputDirectory: string,
): Promise<void> {
  const repo = resolve(import.meta.dir, "..");
  const output = resolve(outputDirectory);
  await mkdir(output); // Every run gets a fresh workspace; do not overwrite prior evidence.
  const module = relative(output, resolve(repo, "src/dsl")).replaceAll(
    "\\",
    "/",
  );
  const source = (
    await readFile(
      resolve(repo, "examples/active-customer/semantic.ts"),
      "utf8",
    )
  ).replace(
    '"../../src/dsl"',
    JSON.stringify(module.startsWith(".") ? module : `./${module}`),
  );
  await writeFile(resolve(output, "semantic.ts"), source);
  await writeFile(
    resolve(output, "contract.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'import { isActiveCustomer } from "./is-active-customer.generated";',
      'test("accepted, suspended, deleted and missing contact", () => {',
      '  expect(isActiveCustomer({ status: "active", deletedAt: null, email: "" })).toBe(true);',
      '  expect(isActiveCustomer({ status: "suspended", deletedAt: null, email: "synthetic" })).toBe(false);',
      '  expect(isActiveCustomer({ status: "active", deletedAt: "synthetic", email: "synthetic" })).toBe(false);',
      '  expect(isActiveCustomer({ status: "active", deletedAt: null, email: null })).toBe(false);',
      "});",
    ].join("\n"),
  );
  await writeFile(
    resolve(output, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        scripts: {
          typecheck:
            "bunx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --types bun semantic.ts",
        },
      },
      null,
      2,
    ),
  );
  for (const file of [
    "best-of-n.json",
    "property.json",
    "defective.ir.json",
    "defective.response.fixture.json",
  ])
    await copyFile(
      resolve(repo, "examples/semantic-tdd-extensions", file),
      resolve(output, file),
    );
  await copyFile(
    resolve(repo, "examples/active-customer/openai-response.fixture.json"),
    resolve(output, "good.response.fixture.json"),
  );
  await copyFile(
    resolve(
      repo,
      "examples/active-customer/semantic-test-response.fixture.json",
    ),
    resolve(output, "test-plan.fixture.json"),
  );
  await writeFile(
    resolve(output, "candidates.json"),
    JSON.stringify([
      "defective.response.fixture.json",
      "good.response.fixture.json",
      "good.response.fixture.json",
    ]),
  );
  async function run(
    script: string,
    args: string[],
    expectedExit = 0,
  ): Promise<void> {
    const child = Bun.spawn(
      [process.execPath, "run", resolve(repo, "src", script), ...args],
      {
        cwd: output,
        env: { ...process.env, OPENAI_API_KEY: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const exitCode = await child.exited;
    const [out, err] = await Promise.all([stdout, stderr]);
    if (exitCode !== expectedExit)
      throw new Error(`extension demo failed (${exitCode}): ${out}\n${err}`);
  }
  await run("semantic-cli.ts", [
    "tdd-build",
    "semantic.ts",
    "--test-fixture",
    "test-plan.fixture.json",
    "--best-of-n",
    "best-of-n.json",
    "--candidate-fixtures",
    "candidates.json",
  ]);
  await run("semantic-cli.ts", ["tdd-test", "semantic.ts", "--json"]);
  await run("semantic-cli.ts", ["tdd-replay", "semantic.ts"]);
  await run("semantic-property-cli.ts", [
    "check",
    "semantic.ts",
    "--config",
    "property.json",
    "--out",
    "property-pass.json",
  ]);
  await run(
    "semantic-property-cli.ts",
    [
      "check",
      "semantic.ts",
      "--config",
      "property.json",
      "--candidate",
      "defective.ir.json",
      "--out",
      "property-fail.json",
    ],
    1,
  );
  await run("semantic-property-cli.ts", ["replay", "property-pass.json"]);
  await run("semantic-property-cli.ts", ["replay", "property-fail.json"], 1);
  console.log(`Semantic TDD extension fixture demo passed: ${output}`);
}

if (import.meta.main) {
  const output = Bun.argv[2];
  if (output === undefined)
    throw new Error(
      "Usage: bun run semantic:extensions:demo <new-output-directory>",
    );
  await runTddExtensionDemo(output);
}
