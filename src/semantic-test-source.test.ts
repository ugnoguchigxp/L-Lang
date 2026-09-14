import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { scanSemanticSource } from "./semantic-source";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("extended Semantic Test source", () => {
  test("extracts typed boundary, counterfactual, and invariance sections", async () => {
    const path = await writeSource(`
{
  accept: [{ state: "ready" }],
  reject: [{ state: "stopped" }],
  boundary: [
    { name: "edge", input: { state: "ready" }, expected: "accepted" },
  ],
  counterfactual: [
    {
      name: "transition",
      base: { input: { state: "ready" }, expected: "accepted" },
      variants: [
        { name: "stop", input: { state: "stopped" }, expected: "rejected" },
      ],
    },
  ],
  invariance: [
    {
      name: "stable",
      expected: "accepted",
      inputs: [{ state: "ready" }, { state: "ready" }],
    },
  ],
}
`);
    const source = await scanSemanticSource(path);
    expect(source.tests.boundarySource).toContain('name: "edge"');
    expect(source.tests.counterfactualSource).toContain('name: "transition"');
    expect(source.tests.invarianceSource).toContain('name: "stable"');
  });

  test("rejects malformed and dynamic extended cases before generation", async () => {
    const cases = [
      {
        source: `{
  accept: [{ state: "ready" }],
  reject: [{ state: "stopped" }],
  boundary: [{ name: "edge", input: { state: "ready" }, expected: "unknown" }],
}`,
        message: "expected must be accepted or rejected",
      },
      {
        source: `{
  accept: [{ state: "ready" }],
  reject: [{ state: "stopped" }],
  boundary: [
    { name: "same", input: { state: "ready" }, expected: "accepted" },
    { name: "same", input: { state: "stopped" }, expected: "rejected" },
  ],
}`,
        message: "contains duplicate name same",
      },
      {
        source: `{
  accept: [{ state: "ready" }],
  reject: [{ state: "stopped" }],
  counterfactual: [{
    name: "transition",
    base: { input: { state: "ready" }, expected: "accepted" },
    variants: [],
  }],
}`,
        message: "variants must be a non-empty array literal",
      },
      {
        source: `{
  accept: [{ state: "ready" }],
  reject: [{ state: "stopped" }],
  invariance: [{
    name: "dynamic",
    expected: "accepted",
    inputs: [dynamicInput],
  }],
}`,
        message: "semantic cases must contain only static literals",
      },
      {
        source: `{
  accept: [{ state: "ready" }],
  reject: [{ state: "stopped" }],
  boundary: [{ ...namedCase }],
}`,
        message: "only supports explicit property assignments",
      },
      {
        source: `{
  accept: [{ state: "ready",
    // @ts-ignore exercise the scanner's defense after TypeScript diagnostics
    state: "stopped" }],
  reject: [{ state: "stopped" }],
}`,
        message: "duplicate object property state",
      },
      {
        source: `{
  accept: [{ state: "ready", score: !1 }],
  reject: [{ state: "stopped" }],
}`,
        message: "semantic cases must contain only static literals",
      },
    ];

    for (const item of cases) {
      const path = await writeSource(item.source);
      await expect(scanSemanticSource(path)).rejects.toThrow(item.message);
    }
  }, 20_000);
});

async function writeSource(cases: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "semantic-test-source-"));
  roots.push(root);
  await writeFile(
    resolve(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      include: ["**/*.ts"],
    }),
    "utf8",
  );
  const sourcePath = resolve(root, "semantic.ts");
  await writeFile(
    sourcePath,
    `
declare function concept<T>(strings: TemplateStringsArray): unknown;
declare function generatePredicate<T>(concept: unknown): (value: T) => boolean;
declare function semanticTest<T>(predicate: (value: T) => boolean, cases: unknown): void;

type State = { state: "ready" | "stopped" };
const dynamicInput: State = { state: "ready" };
const namedCase = {
  name: "spread",
  input: { state: "ready" as const },
  expected: "accepted" as const,
};
const Ready = concept<State>\`Definition:
A ready state.

Requirements:
- state is ready.

Exclusions:
- state is stopped.
\`;
export const isReady = generatePredicate<State>(Ready);
semanticTest(isReady, ${cases});
`.trimStart(),
    "utf8",
  );
  return sourcePath;
}
