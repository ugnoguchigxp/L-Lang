import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import ts from "typescript";

export type SemanticSourceKind = "predicate" | "static-judgment";

export async function detectSemanticSourceKind(
  sourcePath: string,
): Promise<SemanticSourceKind> {
  const absolutePath = resolve(sourcePath);
  const sourceText = await readFile(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let predicates = 0;
  let judgments = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      if (node.expression.text === "generatePredicate") predicates += 1;
      if (node.expression.text === "judgeStatic") judgments += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (predicates > 0 && judgments > 0) {
    throw new Error(
      `${basename(absolutePath)} mixes generatePredicate and judgeStatic; split them into separate semantic sources`,
    );
  }
  if (judgments > 0) return "static-judgment";
  if (predicates > 0) return "predicate";
  throw new Error(
    `${basename(absolutePath)} contains neither generatePredicate nor judgeStatic`,
  );
}
