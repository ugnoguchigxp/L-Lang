import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import ts from "typescript";

import { resolveContainedFile } from "./contained-path";
import { formatDiagnostics } from "./semantic-source-diagnostics";

export type TypeScriptSourceLoadErrorCode =
  | "SOURCE_PATH"
  | "SOURCE_TOO_LARGE"
  | "TSCONFIG_NOT_FOUND"
  | "TYPESCRIPT_DIAGNOSTIC"
  | "SOURCE_NOT_LOADED";

export class TypeScriptSourceLoadError extends Error {
  override name = "TypeScriptSourceLoadError";

  constructor(
    public readonly code: TypeScriptSourceLoadErrorCode,
    message: string,
    public readonly diagnostics: readonly ts.Diagnostic[] = [],
  ) {
    super(message);
  }
}

export type LoadedTypeScriptSource = {
  absolutePath: string;
  sourceText: string;
  sourceFile: ts.SourceFile;
  program: ts.Program;
  checker: ts.TypeChecker;
  configPath: string;
};

export type LoadTypeScriptSourceInput = {
  sourcePath: string;
  workspaceRoot?: string;
  maximumBytes?: number;
  rejectSymbolicLinks?: boolean;
  includeConfigDiagnostics?: boolean;
};

export async function loadTypeScriptSource(
  input: LoadTypeScriptSourceInput,
): Promise<LoadedTypeScriptSource> {
  let absolutePath: string;
  if (input.workspaceRoot === undefined) {
    absolutePath = resolve(input.sourcePath);
  } else {
    try {
      absolutePath = await resolveContainedFile(
        input.workspaceRoot,
        input.sourcePath,
        "TypeScript source",
        { rejectSymbolicLinks: input.rejectSymbolicLinks === true },
      );
    } catch (error) {
      throw new TypeScriptSourceLoadError(
        "SOURCE_PATH",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (
    input.maximumBytes !== undefined &&
    (await stat(absolutePath)).size > input.maximumBytes
  ) {
    throw new TypeScriptSourceLoadError(
      "SOURCE_TOO_LARGE",
      `TypeScript source exceeds ${input.maximumBytes} bytes`,
    );
  }
  const sourceData = await readFile(absolutePath);
  if (
    input.maximumBytes !== undefined &&
    sourceData.byteLength > input.maximumBytes
  ) {
    throw new TypeScriptSourceLoadError(
      "SOURCE_TOO_LARGE",
      `TypeScript source exceeds ${input.maximumBytes} bytes`,
    );
  }
  const sourceText = sourceData.toString("utf8");
  const configPath = ts.findConfigFile(
    dirname(absolutePath),
    ts.sys.fileExists,
  );
  if (configPath === undefined) {
    throw new TypeScriptSourceLoadError(
      "TSCONFIG_NOT_FOUND",
      `tsconfig.json was not found for ${absolutePath}`,
    );
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new TypeScriptSourceLoadError(
      "TYPESCRIPT_DIAGNOSTIC",
      formatDiagnostics([configFile.error]),
      [configFile.error],
    );
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
    throw new TypeScriptSourceLoadError(
      "SOURCE_NOT_LOADED",
      `TypeScript could not load ${absolutePath}`,
    );
  }

  const diagnostics = [
    ...(input.includeConfigDiagnostics === true ? parsed.errors : []),
    ...ts.getPreEmitDiagnostics(program, sourceFile),
  ].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) {
    throw new TypeScriptSourceLoadError(
      "TYPESCRIPT_DIAGNOSTIC",
      formatDiagnostics(diagnostics),
      diagnostics,
    );
  }

  return {
    absolutePath,
    sourceText,
    sourceFile,
    program,
    checker: program.getTypeChecker(),
    configPath,
  };
}
