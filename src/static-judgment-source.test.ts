import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { detectSemanticSourceKind } from "./semantic-source-kind";
import { scanStaticJudgmentSource } from "./static-judgment-source";

const workspaceRoot = resolve(import.meta.dir, "..");
const example = resolve(workspaceRoot, "examples/static-judgment/semantic.ts");

describe("static judgment source scanner", () => {
  test("extracts an imported Concept, literal Static value, and Judgment", async () => {
    const source = await scanStaticJudgmentSource(example);

    expect(source.concept.id).toBe("animal.cat");
    expect(source.concept.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(source.value.name).toBe("mike");
    expect(source.value.text).toContain("calico animal");
    expect(source.judgment.name).toBe("mikeIsCat");
    expect(await detectSemanticSourceKind(example)).toBe("static-judgment");
  });

  test("rejects dynamic Static values before resolution", async () => {
    const fixture = await writeFixture([
      'import { defineConcept, judgeStatic, staticValue } from "__DSL__";',
      'const Cat = defineConcept("animal.cat")`A biological cat.`;',
      'const runtimeDescription = "a cat";',
      "const value = staticValue(runtimeDescription);",
      "export const result = judgeStatic(value, Cat);",
      "",
    ]);
    try {
      await expect(scanStaticJudgmentSource(fixture)).rejects.toThrow(
        "staticValue requires a string literal without substitutions",
      );
    } finally {
      await rmFixture(fixture);
    }
  });

  test("rejects template substitutions and unknown Static value references", async () => {
    const substituted = await writeFixture([
      'import { defineConcept, judgeStatic, staticValue } from "__DSL__";',
      'const Cat = defineConcept("animal.cat")`A biological cat.`;',
      'const detail = "cat";',
      "const value = staticValue(`a ${detail}`);",
      "export const result = judgeStatic(value, Cat);",
      "",
    ]);
    try {
      await expect(scanStaticJudgmentSource(substituted)).rejects.toThrow(
        "staticValue requires a string literal without substitutions",
      );
    } finally {
      await rmFixture(substituted);
    }

    const unknown = await writeFixture([
      'import { defineConcept, judgeStatic, staticValue } from "__DSL__";',
      'const Cat = defineConcept("animal.cat")`A biological cat.`;',
      'const first = staticValue("a cat");',
      'const second = first;',
      "export const result = judgeStatic(second, Cat);",
      "",
    ]);
    try {
      await expect(scanStaticJudgmentSource(unknown)).rejects.toThrow(
        "references unknown static value second",
      );
    } finally {
      await rmFixture(unknown);
    }
  });

  test("rejects multiple Judgments and mixed semantic source forms", async () => {
    const multiple = await writeFixture([
      'import { defineConcept, judgeStatic, staticValue } from "__DSL__";',
      'const Cat = defineConcept("animal.cat")`A biological cat.`;',
      'const value = staticValue("a cat");',
      "export const first = judgeStatic(value, Cat);",
      "export const second = judgeStatic(value, Cat);",
      "",
    ]);
    try {
      await expect(scanStaticJudgmentSource(multiple)).rejects.toThrow(
        "requires exactly one staticValue and one judgeStatic",
      );
    } finally {
      await rmFixture(multiple);
    }

    const mixed = await writeFixture([
      'import { defineConcept, generatePredicate, judgeStatic, staticValue } from "__DSL__";',
      'const Cat = defineConcept("animal.cat")`A biological cat.`;',
      'const value = staticValue("a cat");',
      "export const result = judgeStatic(value, Cat);",
      "const generated = generatePredicate(Cat);",
      "",
    ]);
    try {
      await expect(detectSemanticSourceKind(mixed)).rejects.toThrow(
        "mixes generatePredicate and judgeStatic",
      );
    } finally {
      await rmFixture(mixed);
    }
  });
});

async function writeFixture(lines: string[]): Promise<string> {
  const parent = resolve(workspaceRoot, ".semantic/test-workspaces");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "static-source-"));
  const path = resolve(directory, "semantic.ts");
  const dslModule = modulePath(relative(directory, resolve(workspaceRoot, "src/dsl")));
  await writeFile(path, lines.join("\n").replace("__DSL__", dslModule), "utf8");
  return path;
}

async function rmFixture(path: string): Promise<void> {
  await rm(resolve(path, ".."), { recursive: true, force: true });
}

function modulePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
