import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateLlangPredicateProjection } from "./llang-predicate-projection";
import type { LlangProgram } from "./llang-program";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function program(): LlangProgram {
  return {
    language: "l-lang",
    version: 1,
    id: "projection-boundaries",
    profile: "predicate-i32-v1",
    description: "*/ doNotRun()",
    contract: {
      version: 1,
      fields: [
        {
          name: "$flag",
          kind: "boolean",
          values: [],
          nullable: false,
          undefinable: false,
          optional: false,
        },
        {
          name: "__proto__",
          kind: "boolean",
          values: [],
          nullable: false,
          undefinable: false,
          optional: true,
        },
        {
          name: "constructor",
          kind: "boolean",
          values: [],
          nullable: false,
          undefinable: true,
          optional: true,
        },
        {
          name: "mode",
          kind: "enum",
          values: ['a"b', "line\nbreak"],
          nullable: false,
          undefinable: false,
          optional: false,
        },
        {
          name: "name",
          kind: "string",
          values: [],
          nullable: false,
          undefinable: false,
          optional: true,
        },
        {
          name: "nullable",
          kind: "enum",
          values: ["value"],
          nullable: true,
          undefinable: false,
          optional: false,
        },
      ],
    },
    body: {
      kind: "all",
      conditions: [
        { kind: "equals", property: ["$flag"], value: true },
        { kind: "present", property: ["constructor"] },
        {
          kind: "any",
          conditions: [
            { kind: "equals", property: ["mode"], value: 'a"b' },
            { kind: "equals", property: ["nullable"], value: null },
          ],
        },
        {
          kind: "not",
          condition: { kind: "present", property: ["name"] },
        },
        {
          kind: "not",
          condition: { kind: "present", property: ["__proto__"] },
        },
      ],
    },
  };
}

async function loadProjection(source: string) {
  const javascript = `${new Bun.Transpiler({ loader: "ts" }).transformSync(source)}\n// ${crypto.randomUUID()}`;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  )) as { evaluate(input: Record<string, unknown>): boolean };
}

describe("L-Lang predicate inspection projection", () => {
  test("generates deterministic self-contained TypeScript with precise field types", () => {
    const source = generateLlangPredicateProjection(program());
    expect(generateLlangPredicateProjection(program())).toBe(source);
    expect(source).toContain('"constructor"?: boolean | undefined;');
    expect(source).toContain('"__proto__"?: boolean;');
    expect(source).toContain('"nullable": "value" | null;');
    expect(source).toContain('"mode": "a\\"b" | "line\\nbreak";');
    expect(source).toContain('ownValue(input, "constructor")');
    expect(source).not.toContain("doNotRun");
  });

  test("executes nested conditions without reading inherited properties or accessors", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "llang-projection-"));
    roots.push(root);
    const path = resolve(root, "projection.ts");
    const source = generateLlangPredicateProjection(program());
    await writeFile(
      path,
      `${source}
const omittedOptional: Input = { $flag: true, ["__proto__"]: false, constructor: undefined, mode: 'a"b', nullable: null };
const explicitUndefined: Input = { $flag: true, ["__proto__"]: false, constructor: undefined, mode: 'a"b', nullable: null };
// @ts-expect-error optional-only fields reject an explicit undefined value.
const invalidOptional: Input = { $flag: true, ["__proto__"]: false, constructor: undefined, mode: 'a"b', name: undefined, nullable: null };
void omittedOptional;
void explicitUndefined;
void invalidOptional;
`,
    );
    const typecheck = Bun.spawn(
      [
        process.execPath,
        resolve("node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--skipLibCheck",
        path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [typecheckCode, typecheckOut, typecheckError] = await Promise.all([
      typecheck.exited,
      new Response(typecheck.stdout).text(),
      new Response(typecheck.stderr).text(),
    ]);
    if (typecheckCode !== 0)
      throw new Error(
        `generated projection did not typecheck:\n${typecheckOut}${typecheckError}`,
      );
    const projection = await loadProjection(source);

    expect(
      projection.evaluate({
        $flag: true,
        constructor: true,
        mode: 'a"b',
        nullable: "value",
      }),
    ).toBe(true);
    expect(
      projection.evaluate({
        $flag: true,
        mode: "line\nbreak",
        nullable: null,
      }),
    ).toBe(false);

    let getterCalled = false;
    const accessor = {
      $flag: true,
      mode: 'a"b',
      nullable: "value",
      get constructor() {
        getterCalled = true;
        return true;
      },
    };
    expect(projection.evaluate(accessor)).toBe(false);
    expect(getterCalled).toBe(false);
    expect(
      projection.evaluate(
        JSON.parse(
          '{"$flag":true,"constructor":true,"mode":"a\\"b","nullable":"value","__proto__":true}',
        ),
      ),
    ).toBe(false);
  });
});
