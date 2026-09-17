import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import { SEMANTIC_LIMITS } from "./semantic-limits";
import {
  importTypeScriptPredicate,
  TypeScriptImportError,
} from "./typescript-predicate-importer";

const repo = resolve(import.meta.dir, "..");
const example = resolve(repo, "examples/hybrid-order/can-ship.ts");

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const parent = resolve(repo, ".semantic", "typescript-importer-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "case-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      await writeFile(resolve(root, path), contents);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectCode(
  root: string,
  sourcePath: string,
  functionName: string,
  code: TypeScriptImportError["code"],
): Promise<void> {
  await expect(
    importTypeScriptPredicate({
      workspaceRoot: root,
      sourcePath,
      functionName,
    }),
  ).rejects.toMatchObject({ code });
}

describe("restricted TypeScript predicate importer", () => {
  test("imports same-file types, absence, all, any, and not", async () => {
    const canShip = await importTypeScriptPredicate({
      workspaceRoot: repo,
      sourcePath: example,
      functionName: "canShip",
    });
    expect(canShip.source.file).toBe("examples/hybrid-order/can-ship.ts");
    expect(canShip.input.typeName).toBe("Order");
    expect(canShip.body).toEqual({
      kind: "all",
      conditions: [
        {
          kind: "all",
          conditions: [
            {
              kind: "all",
              conditions: [
                {
                  kind: "equals",
                  property: ["paymentStatus"],
                  value: "paid",
                },
                {
                  kind: "equals",
                  property: ["inventoryReserved"],
                  value: true,
                },
              ],
            },
            {
              kind: "not",
              condition: { kind: "present", property: ["holdReason"] },
            },
          ],
        },
        {
          kind: "not",
          condition: {
            kind: "equals",
            property: ["cancelled"],
            value: true,
          },
        },
      ],
    });
    const review = await importTypeScriptPredicate({
      workspaceRoot: repo,
      sourcePath: example,
      functionName: "needsManualReview",
    });
    expect(review.body).toHaveProperty("kind", "any");
    expect(review.contract.fields.map((field) => field.name)).toEqual([
      "approved",
      "priority",
      "reviewer",
    ]);
  });

  test("canonicalizes reversed operands and nullish order", async () =>
    fixture(
      {
        "case.ts": `
type Status = "yes" | "no";
interface Input {
  status: Status;
  ready: boolean;
  note?: string | null | undefined;
}
export function decide(input: Input): boolean {
  return ("yes" === input.status || false !== input.ready) &&
    (undefined !== input.note && null !== input.note);
}
throw new Error("the importer must not execute its source");`,
      },
      async (root) => {
        const result = await importTypeScriptPredicate({
          workspaceRoot: root,
          sourcePath: "case.ts",
          functionName: "decide",
        });
        expect(result.body).toEqual({
          kind: "all",
          conditions: [
            {
              kind: "any",
              conditions: [
                {
                  kind: "equals",
                  property: ["status"],
                  value: "yes",
                },
                {
                  kind: "not",
                  condition: {
                    kind: "equals",
                    property: ["ready"],
                    value: false,
                  },
                },
              ],
            },
            { kind: "present", property: ["note"] },
          ],
        });
      },
    ));

  test("semantic hash ignores path and formatting while source hash does not", async () =>
    fixture(
      {
        "a.ts": `type Input={enabled:boolean};\nexport function decide(input:Input):boolean{return input.enabled===true;}`,
        "b.ts": `type Input = { enabled: boolean };\n\nexport function decide(\n  input: Input,\n): boolean {\n  return (input.enabled === true);\n}\n`,
      },
      async (root) => {
        const a = await importTypeScriptPredicate({
          workspaceRoot: root,
          sourcePath: "a.ts",
          functionName: "decide",
        });
        const b = await importTypeScriptPredicate({
          workspaceRoot: root,
          sourcePath: "b.ts",
          functionName: "decide",
        });
        expect(a.semanticHash).toBe(b.semanticHash);
        expect(a.source.sourceHash).not.toBe(b.source.sourceHash);
        expect(a.source.file).not.toBe(b.source.file);
      },
    ));

  test("treats an undefined property name as data, not a shadowed binding", async () =>
    fixture(
      {
        "undefined-field.ts":
          "type I={undefined:boolean}; export function decide(input:I):boolean{return input.undefined===true;}",
      },
      async (root) => {
        const result = await importTypeScriptPredicate({
          workspaceRoot: root,
          sourcePath: "undefined-field.ts",
          functionName: "decide",
        });
        expect(result.body).toEqual({
          kind: "equals",
          property: ["undefined"],
          value: true,
        });
      },
    ));

  test(
    "classifies unsupported signatures, types, syntax, and diagnostics",
    async () =>
      fixture(
        {
          "model.ts": "export interface Imported { ready: boolean }",
          "status.ts":
            'export type ImportedStatus = "yes" | "no"; export interface Base { ready: boolean }',
          "arrow.ts":
            "type I={ready:boolean}; export const decide=(input:I):boolean=>input.ready===true;",
          "inferred.ts":
            "type I={ready:boolean}; export function decide(input:I){return input.ready===true;}",
          "generic.ts":
            "type I={ready:boolean}; export function decide<T>(input:I):boolean{return input.ready===true;}",
          "number.ts":
            "type I={count:number}; export function decide(input:I):boolean{return input.count===1;}",
          "array.ts":
            "type I={items:string[];ready:boolean}; export function decide(input:I):boolean{return input.ready===true;}",
          "nested.ts":
            "type I={child:{ready:boolean};ready:boolean}; export function decide(input:I):boolean{return input.ready===true;}",
          "indexed.ts":
            "interface I { ready:boolean; [name:string]:boolean } export function decide(input:I):boolean{return input.ready===true;}",
          "callable.ts":
            "interface I { ():void; ready:boolean } export function decide(input:I):boolean{return input.ready===true;}",
          "imported.ts":
            'import type { Imported } from "./model"; export function decide(input:Imported):boolean{return input.ready===true;}',
          "imported-alias.ts":
            'import type { ImportedStatus } from "./status"; interface I { status: ImportedStatus } export function decide(input:I):boolean{return input.status==="yes";}',
          "imported-base.ts":
            'import type { Base } from "./status"; interface I extends Base {} export function decide(input:I):boolean{return input.ready===true;}',
          "imported-mapped.ts":
            'import type { Base } from "./status"; type I = { [K in keyof Base]: Base[K] }; export function decide(input:I):boolean{return input.ready===true;}',
          "shadowed-undefined.ts":
            "const undefined = null; type I={note?:string|null|undefined}; export function decide(input:I):boolean{return input.note!==null&&input.note!==undefined;}",
          "loose.ts":
            "type I={ready:boolean}; export function decide(input:I):boolean{return input.ready==true;}",
          "truthy.ts":
            "type I={ready:boolean}; export function decide(input:I):boolean{return input.ready;}",
          "overload.ts": `type I={ready:boolean};
export function decide(input:I):boolean;
export function decide(input:I):boolean{return input.ready===true;}`,
          "diagnostic.ts":
            "type I={ready:boolean}; export function decide(input:I):boolean{return input.missing===true;}",
        },
        async (root) => {
          await expectCode(root, "arrow.ts", "decide", "FUNCTION_NOT_FOUND");
          await expectCode(
            root,
            "inferred.ts",
            "decide",
            "UNSUPPORTED_SIGNATURE",
          );
          await expectCode(
            root,
            "generic.ts",
            "decide",
            "UNSUPPORTED_SIGNATURE",
          );
          await expectCode(root, "number.ts", "decide", "UNSUPPORTED_TYPE");
          await expectCode(root, "array.ts", "decide", "UNSUPPORTED_TYPE");
          await expectCode(root, "nested.ts", "decide", "UNSUPPORTED_TYPE");
          await expectCode(root, "indexed.ts", "decide", "UNSUPPORTED_TYPE");
          await expectCode(root, "callable.ts", "decide", "UNSUPPORTED_TYPE");
          await expectCode(root, "imported.ts", "decide", "UNSUPPORTED_TYPE");
          await expectCode(
            root,
            "imported-alias.ts",
            "decide",
            "UNSUPPORTED_TYPE",
          );
          await expectCode(
            root,
            "imported-base.ts",
            "decide",
            "UNSUPPORTED_TYPE",
          );
          await expectCode(
            root,
            "imported-mapped.ts",
            "decide",
            "UNSUPPORTED_TYPE",
          );
          await expectCode(
            root,
            "shadowed-undefined.ts",
            "decide",
            "UNSUPPORTED_SYNTAX",
          );
          await expectCode(root, "loose.ts", "decide", "UNSUPPORTED_SYNTAX");
          await expectCode(root, "truthy.ts", "decide", "UNSUPPORTED_SYNTAX");
          await expectCode(root, "overload.ts", "decide", "AMBIGUOUS_FUNCTION");
          await expectCode(
            root,
            "diagnostic.ts",
            "decide",
            "TYPESCRIPT_DIAGNOSTIC",
          );
        },
      ),
    30000,
  );

  test("rejects paths outside the workspace and symbolic links", async () =>
    fixture(
      {
        "inside.ts":
          "type I={ready:boolean}; export function decide(input:I):boolean{return input.ready===true;}",
      },
      async (root) => {
        await expectCode(
          root,
          resolve(repo, "examples/hybrid-order/can-ship.ts"),
          "canShip",
          "SOURCE_OUTSIDE_WORKSPACE",
        );
        const link = resolve(root, "link.ts");
        await symlink(resolve(root, "inside.ts"), link);
        await expectCode(root, link, "decide", "SOURCE_OUTSIDE_WORKSPACE");
      },
    ));

  test("rejects a source larger than the dedicated limit", async () =>
    fixture(
      {
        "large.ts": `${" ".repeat(2 * 1024 * 1024)}x`,
      },
      async (root) => {
        await expectCode(root, "large.ts", "decide", "SOURCE_TOO_LARGE");
      },
    ));

  test("keeps absolute paths out of public diagnostic messages", async () =>
    fixture(
      {
        "bad.ts":
          "type I={ready:boolean}; export function decide(input:I):boolean{return input.nope===true;}",
        "absolute-import.ts":
          'import type { Missing } from "/private/l lang secret/model"; export function decide(input:Missing):boolean{return input.ready===true;}',
      },
      async (root) => {
        try {
          await importTypeScriptPredicate({
            workspaceRoot: root,
            sourcePath: resolve(root, "bad.ts"),
            functionName: "decide",
          });
          throw new Error("expected importer failure");
        } catch (error) {
          expect(error).toBeInstanceOf(TypeScriptImportError);
          expect((error as Error).message).toContain("bad.ts:1:");
          expect((error as Error).message).not.toContain(root);
        }
        try {
          await importTypeScriptPredicate({
            workspaceRoot: root,
            sourcePath: "absolute-import.ts",
            functionName: "decide",
          });
          throw new Error("expected importer failure");
        } catch (error) {
          expect(error).toBeInstanceOf(TypeScriptImportError);
          expect((error as Error).message).not.toContain(
            "/private/l lang secret/model",
          );
          expect((error as Error).message).not.toContain("lang secret/model");
        }
      },
    ));

  test("bounds public diagnostics without echoing unsupported source", async () =>
    fixture(
      {
        "large-expression.ts": `type I={ready:boolean}; export function decide(input:I):boolean{return Boolean("${"x".repeat(4_000)}");}`,
      },
      async (root) => {
        try {
          await importTypeScriptPredicate({
            workspaceRoot: root,
            sourcePath: "large-expression.ts",
            functionName: "decide",
          });
          throw new Error("expected importer failure");
        } catch (error) {
          expect(error).toBeInstanceOf(TypeScriptImportError);
          expect((error as Error).message.length).toBeLessThanOrEqual(
            SEMANTIC_LIMITS.diagnosticCharacters,
          );
          expect((error as Error).message).not.toContain("x".repeat(100));
        }
      },
    ));

  test("does not modify the imported source", async () => {
    const before = await readFile(example, "utf8");
    await importTypeScriptPredicate({
      workspaceRoot: repo,
      sourcePath: example,
      functionName: "canShip",
    });
    expect(await readFile(example, "utf8")).toBe(before);
  });
});
