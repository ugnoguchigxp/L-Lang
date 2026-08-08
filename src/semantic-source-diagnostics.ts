import { basename } from "node:path";

import ts from "typescript";

export class SemanticSourceError extends Error {
  override name = "SemanticSourceError";
}

export function sourceError(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  message: string,
): SemanticSourceError {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return new SemanticSourceError(
    `${basename(sourceFile.fileName)}:${position.line + 1}:${position.character + 1}: ${message}`,
  );
}

export function formatDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  });
}
