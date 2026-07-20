import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import ts from "typescript";

import {
  formatDiagnostics,
  hashConcept,
  resolveConceptDefinition,
  SemanticSourceError,
  sourceError,
} from "./semantic-source";

export type StaticJudgmentSource = {
  absolutePath: string;
  sourceText: string;
  sourceFile: ts.SourceFile;
  program: ts.Program;
  checker: ts.TypeChecker;
  concept: {
    name: string;
    id: string;
    hash: string;
    definitionName: string;
    definitionPath: string;
    specification: string;
  };
  value: {
    name: string;
    text: string;
    node: ts.CallExpression;
  };
  judgment: {
    name: string;
    valueName: string;
    conceptName: string;
    node: ts.CallExpression;
  };
};

export async function scanStaticJudgmentSource(
  sourcePath: string,
): Promise<StaticJudgmentSource> {
  const absolutePath = resolve(sourcePath);
  const sourceText = await readFile(absolutePath, "utf8");
  const configPath = ts.findConfigFile(dirname(absolutePath), ts.sys.fileExists);

  if (configPath === undefined) {
    throw new SemanticSourceError(`tsconfig.json was not found for ${absolutePath}`);
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new SemanticSourceError(formatDiagnostics([configFile.error]));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
  );
  const rootNames = parsed.fileNames.includes(absolutePath)
    ? parsed.fileNames
    : [...parsed.fileNames, absolutePath];
  const program = ts.createProgram({ rootNames, options: parsed.options });
  const sourceFile = program.getSourceFile(absolutePath);

  if (sourceFile === undefined) {
    throw new SemanticSourceError(`TypeScript could not load ${absolutePath}`);
  }

  const sourceDiagnostics = ts
    .getPreEmitDiagnostics(program, sourceFile)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (sourceDiagnostics.length > 0) {
    throw new SemanticSourceError(formatDiagnostics(sourceDiagnostics));
  }

  const checker = program.getTypeChecker();
  const values: StaticJudgmentSource["value"][] = [];
  const judgments: StaticJudgmentSource["judgment"][] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) {
        continue;
      }
      const initializer = declaration.initializer;
      if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "staticValue"
      ) {
        if (initializer.arguments.length !== 1) {
          throw sourceError(
            sourceFile,
            initializer,
            "staticValue requires exactly one literal string argument",
          );
        }
        const argument = initializer.arguments[0]!;
        if (
          !ts.isStringLiteral(argument) &&
          !ts.isNoSubstitutionTemplateLiteral(argument)
        ) {
          throw sourceError(
            sourceFile,
            argument,
            "staticValue requires a string literal without substitutions",
          );
        }
        values.push({
          name: declaration.name.text,
          text: argument.text.trim(),
          node: initializer,
        });
        continue;
      }

      if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "judgeStatic"
      ) {
        if (
          initializer.arguments.length !== 2 ||
          !ts.isIdentifier(initializer.arguments[0]!) ||
          !ts.isIdentifier(initializer.arguments[1]!)
        ) {
          throw sourceError(
            sourceFile,
            initializer,
            "judgeStatic requires staticValue and Concept identifiers",
          );
        }
        judgments.push({
          name: declaration.name.text,
          valueName: initializer.arguments[0]!.text,
          conceptName: initializer.arguments[1]!.text,
          node: initializer,
        });
      }
    }
  }

  if (values.length !== 1 || judgments.length !== 1) {
    throw new SemanticSourceError(
      `Static Judgment MVP requires exactly one staticValue and one judgeStatic; found ${values.length}/${judgments.length}`,
    );
  }

  const value = values[0]!;
  const judgment = judgments[0]!;
  if (judgment.valueName !== value.name) {
    throw sourceError(
      sourceFile,
      judgment.node,
      `semantic closure failed: ${judgment.name} references unknown static value ${judgment.valueName}`,
    );
  }

  const conceptReference = judgment.node.arguments[1]!;
  if (!ts.isIdentifier(conceptReference)) {
    throw sourceError(
      sourceFile,
      conceptReference,
      "judgeStatic Concept must be an identifier",
    );
  }
  const definition = resolveConceptDefinition(conceptReference, checker, sourceFile);
  const concept = {
    name: judgment.conceptName,
    id: definition.id,
    hash: hashConcept(definition.id, definition.specification),
    definitionName: definition.name,
    definitionPath: definition.sourceFile.fileName,
    specification: definition.specification,
  };

  return {
    absolutePath,
    sourceText,
    sourceFile,
    program,
    checker,
    concept,
    value,
    judgment,
  };
}

export function staticJudgmentSourceName(source: StaticJudgmentSource): string {
  return basename(source.absolutePath);
}
