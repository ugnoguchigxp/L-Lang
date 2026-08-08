import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import ts from "typescript";

import { type PredicateExpression, parsePredicateExpression } from "./ir";
import {
  generatedOutputPath,
  sha256,
  stableJson,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import { assertKnownKeys } from "./semantic-limits";
import type { SemanticLock, SemanticLockEntry } from "./semantic-lock";
import type { SemanticSource } from "./semantic-source";

export const PROJECT_CONTEXT_VERSION = 1 as const;
export const PROJECT_CONTEXT_LIMITS = {
  relatedTypes: 16,
  verifiedBindings: 8,
  bytes: 32 * 1024,
  declarationBytes: 8 * 1024,
  referenceDepth: 3,
} as const;

export type ProjectContext = {
  version: 1;
  target: {
    source: string;
    symbol: string;
    typeName: string;
    typeDeclaration: string;
  };
  relatedTypes: Array<{
    source: string;
    typeName: string;
    declaration: string;
  }>;
  verifiedBindings: Array<{
    conceptId: string;
    source: string;
    targetTypeName: string;
    typeSchemaHash: string;
    resolvedIr: PredicateExpression;
    generatedCodeHash: string;
  }>;
  compilerContext: {
    strict: boolean;
    exactOptionalPropertyTypes: boolean;
    noUncheckedIndexedAccess: boolean;
  };
};

export type ProjectContextSummary = {
  version: 1;
  targetSource: string;
  relatedTypeSources: string[];
  verifiedBindingSources: string[];
};

export type BuiltProjectContext = {
  context: ProjectContext;
  contextHash: string;
  summary: ProjectContextSummary;
};

export function parseProjectContext(
  input: unknown,
  path = "Project Context",
): ProjectContext {
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "version",
      "target",
      "relatedTypes",
      "verifiedBindings",
      "compilerContext",
    ],
    path,
  );
  if (value.version !== PROJECT_CONTEXT_VERSION) {
    throw new Error(`${path}.version must be ${PROJECT_CONTEXT_VERSION}`);
  }

  const targetPath = `${path}.target`;
  const targetValue = recordValue(value.target, targetPath);
  assertExactKeys(
    targetValue,
    ["source", "symbol", "typeName", "typeDeclaration"],
    targetPath,
  );
  const targetTypeName = trimmedString(
    targetValue.typeName,
    `${targetPath}.typeName`,
  );
  const target = {
    source: contextSourcePath(targetValue.source, `${targetPath}.source`),
    symbol: trimmedString(targetValue.symbol, `${targetPath}.symbol`),
    typeName: targetTypeName,
    typeDeclaration: typeOnlyDeclaration(
      trimmedString(
        targetValue.typeDeclaration,
        `${targetPath}.typeDeclaration`,
      ),
      `${targetPath}.typeDeclaration`,
      targetTypeName,
    ),
  };

  if (!Array.isArray(value.relatedTypes)) {
    throw new Error(`${path}.relatedTypes must be an array`);
  }
  if (value.relatedTypes.length > PROJECT_CONTEXT_LIMITS.relatedTypes) {
    throw new Error(
      `${path}.relatedTypes must contain at most ${PROJECT_CONTEXT_LIMITS.relatedTypes} items`,
    );
  }
  const relatedTypes = value.relatedTypes.map((inputType, index) => {
    const itemPath = `${path}.relatedTypes[${index}]`;
    const item = recordValue(inputType, itemPath);
    assertExactKeys(item, ["source", "typeName", "declaration"], itemPath);
    const typeName = trimmedString(item.typeName, `${itemPath}.typeName`);
    return {
      source: contextSourcePath(item.source, `${itemPath}.source`),
      typeName,
      declaration: typeOnlyDeclaration(
        trimmedString(item.declaration, `${itemPath}.declaration`),
        `${itemPath}.declaration`,
        typeName,
      ),
    };
  });
  assertUnique(
    relatedTypes.map((entry) => `${entry.source}\0${entry.typeName}`),
    `${path}.relatedTypes`,
  );

  if (!Array.isArray(value.verifiedBindings)) {
    throw new Error(`${path}.verifiedBindings must be an array`);
  }
  if (value.verifiedBindings.length > PROJECT_CONTEXT_LIMITS.verifiedBindings) {
    throw new Error(
      `${path}.verifiedBindings must contain at most ${PROJECT_CONTEXT_LIMITS.verifiedBindings} items`,
    );
  }
  const verifiedBindings = value.verifiedBindings.map((inputBinding, index) => {
    const itemPath = `${path}.verifiedBindings[${index}]`;
    const item = recordValue(inputBinding, itemPath);
    assertExactKeys(
      item,
      [
        "conceptId",
        "source",
        "targetTypeName",
        "typeSchemaHash",
        "resolvedIr",
        "generatedCodeHash",
      ],
      itemPath,
    );
    return {
      conceptId: trimmedString(item.conceptId, `${itemPath}.conceptId`),
      source: contextSourcePath(item.source, `${itemPath}.source`),
      targetTypeName: trimmedString(
        item.targetTypeName,
        `${itemPath}.targetTypeName`,
      ),
      typeSchemaHash: hashValue(
        item.typeSchemaHash,
        `${itemPath}.typeSchemaHash`,
      ),
      resolvedIr: parsePredicateExpression(
        item.resolvedIr,
        `${itemPath}.resolvedIr`,
      ),
      generatedCodeHash: hashValue(
        item.generatedCodeHash,
        `${itemPath}.generatedCodeHash`,
      ),
    };
  });
  assertUnique(
    verifiedBindings.map((entry) => `${entry.source}\0${entry.targetTypeName}`),
    `${path}.verifiedBindings`,
  );

  const compilerPath = `${path}.compilerContext`;
  const compilerValue = recordValue(value.compilerContext, compilerPath);
  assertExactKeys(
    compilerValue,
    ["strict", "exactOptionalPropertyTypes", "noUncheckedIndexedAccess"],
    compilerPath,
  );
  const context: ProjectContext = {
    version: PROJECT_CONTEXT_VERSION,
    target,
    relatedTypes,
    verifiedBindings,
    compilerContext: {
      strict: booleanValue(compilerValue.strict, `${compilerPath}.strict`),
      exactOptionalPropertyTypes: booleanValue(
        compilerValue.exactOptionalPropertyTypes,
        `${compilerPath}.exactOptionalPropertyTypes`,
      ),
      noUncheckedIndexedAccess: booleanValue(
        compilerValue.noUncheckedIndexedAccess,
        `${compilerPath}.noUncheckedIndexedAccess`,
      ),
    },
  };
  if (
    Buffer.byteLength(stableJson(context), "utf8") >
    PROJECT_CONTEXT_LIMITS.bytes
  ) {
    throw new Error(`${path} exceeds ${PROJECT_CONTEXT_LIMITS.bytes} bytes`);
  }
  return context;
}

export async function buildProjectContext(input: {
  source: SemanticSource;
  workspaceRoot: string;
  lock: SemanticLock;
}): Promise<BuiltProjectContext> {
  const workspaceRoot = await realpath(resolve(input.workspaceRoot));
  const targetSource = await safeWorkspaceFile(
    workspaceRoot,
    input.source.absolutePath,
    "Project Context target",
  );
  assertTypeOnlyDeclarations(
    input.source.concept.inputType.aliasSymbol?.declarations ??
      input.source.concept.inputType.getSymbol()?.declarations ??
      [],
    "Project Context target",
  );
  const targetDeclaration = typeOnlyDeclaration(
    input.source.concept.typeDeclaration,
    "Project Context target declaration",
    input.source.concept.typeName,
  );
  const relatedTypes = await collectRelatedTypes(
    input.source,
    workspaceRoot,
    targetSource,
  );
  const verifiedBindings = await collectVerifiedBindings(
    input.source,
    workspaceRoot,
    input.lock,
    targetSource,
  );
  const options = input.source.program.getCompilerOptions();
  const context: ProjectContext = {
    version: PROJECT_CONTEXT_VERSION,
    target: {
      source: targetSource,
      symbol: input.source.predicate.name,
      typeName: input.source.concept.typeName,
      typeDeclaration: targetDeclaration,
    },
    relatedTypes,
    verifiedBindings,
    compilerContext: {
      strict: options.strict === true,
      exactOptionalPropertyTypes: options.exactOptionalPropertyTypes === true,
      noUncheckedIndexedAccess: options.noUncheckedIndexedAccess === true,
    },
  };
  const serialized = stableJson(context);
  if (Buffer.byteLength(serialized, "utf8") > PROJECT_CONTEXT_LIMITS.bytes) {
    throw new Error(
      `Project Context exceeds ${PROJECT_CONTEXT_LIMITS.bytes} bytes`,
    );
  }
  const summary: ProjectContextSummary = {
    version: 1,
    targetSource,
    relatedTypeSources: relatedTypes.map((entry) => entry.source),
    verifiedBindingSources: verifiedBindings.map((entry) => entry.source),
  };
  return { context, contextHash: sha256(serialized), summary };
}

async function collectRelatedTypes(
  source: SemanticSource,
  workspaceRoot: string,
  targetSource: string,
): Promise<ProjectContext["relatedTypes"]> {
  const result = new Map<string, ProjectContext["relatedTypes"][number]>();
  const visited = new Set<ts.Declaration>();
  const rootDeclarations =
    source.concept.inputType.aliasSymbol?.declarations ??
    source.concept.inputType.getSymbol()?.declarations ??
    [];

  const visit = async (
    declaration: ts.Declaration,
    depth: number,
  ): Promise<void> => {
    if (
      visited.has(declaration) ||
      depth > PROJECT_CONTEXT_LIMITS.referenceDepth
    ) {
      return;
    }
    visited.add(declaration);
    const references: ts.TypeReferenceNode[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isTypeReferenceNode(node)) references.push(node);
      ts.forEachChild(node, walk);
    };
    walk(declaration);
    for (const reference of references) {
      const rawSymbol = source.checker.getSymbolAtLocation(reference.typeName);
      const symbol =
        rawSymbol !== undefined &&
        (rawSymbol.flags & ts.SymbolFlags.Alias) !== 0
          ? source.checker.getAliasedSymbol(rawSymbol)
          : rawSymbol;
      const declarations = symbol?.declarations ?? [];
      for (const related of declarations) {
        const file = related.getSourceFile();
        if (file.isDeclarationFile) continue;
        assertTypeOnlyDeclarations([related], "Project Context related symbol");
        const relativeSource = await safeWorkspaceFile(
          workspaceRoot,
          file.fileName,
          "Project Context related type",
        );
        if (relativeSource === targetSource || excludedSource(relativeSource)) {
          continue;
        }
        const name = declarationName(related, source.checker);
        const key = `${relativeSource}\0${name}`;
        if (!result.has(key)) {
          if (result.size >= PROJECT_CONTEXT_LIMITS.relatedTypes) {
            throw new Error(
              `Project Context exceeds ${PROJECT_CONTEXT_LIMITS.relatedTypes} related types`,
            );
          }
          result.set(key, {
            source: relativeSource,
            typeName: name,
            declaration: typeOnlyDeclaration(
              related.getText(file),
              `Project Context declaration ${relativeSource}:${name}`,
              name,
            ),
          });
        }
        await visit(related, depth + 1);
      }
    }
  };
  for (const declaration of rootDeclarations) await visit(declaration, 1);
  return [...result.values()].sort(compareContextEntry);
}

async function collectVerifiedBindings(
  source: SemanticSource,
  workspaceRoot: string,
  lock: SemanticLock,
  currentSource: string,
): Promise<ProjectContext["verifiedBindings"]> {
  const latestByBinding = new Map<string, SemanticLockEntry>();
  for (const entry of Object.values(lock.entries)) {
    if (
      entry.source === currentSource ||
      !currentVerifiedBinding(entry, source)
    ) {
      continue;
    }
    const key = `${entry.source}\0${entry.predicate}`;
    const previous = latestByBinding.get(key);
    if (
      previous === undefined ||
      entry.createdAt.localeCompare(previous.createdAt) > 0
    ) {
      latestByBinding.set(key, entry);
    }
  }
  const candidates = [...latestByBinding.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.predicate.localeCompare(right.predicate),
  );
  if (candidates.length > PROJECT_CONTEXT_LIMITS.verifiedBindings) {
    throw new Error(
      `Project Context exceeds ${PROJECT_CONTEXT_LIMITS.verifiedBindings} verified bindings`,
    );
  }
  const bindings: ProjectContext["verifiedBindings"] = [];
  for (const entry of candidates) {
    const targetTypeName = entry.targetTypeName;
    if (targetTypeName === undefined) continue;
    let sourcePath: string;
    try {
      sourcePath = await safeWorkspaceFile(
        workspaceRoot,
        resolve(workspaceRoot, entry.source),
        "Project Context verified binding",
      );
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    if (excludedSource(sourcePath)) continue;
    if (
      sha256(await readFile(resolve(workspaceRoot, sourcePath))) !==
      entry.sourceHash
    ) {
      continue;
    }
    const outputPath = generatedOutputPath(
      resolve(workspaceRoot, entry.source),
      entry.predicate,
    );
    let outputRelative: string;
    try {
      outputRelative = await safeWorkspaceFile(
        workspaceRoot,
        outputPath,
        "Project Context generated binding",
      );
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    if (
      sha256(await readFile(resolve(workspaceRoot, outputRelative))) !==
      entry.generatedCodeHash
    ) {
      continue;
    }
    bindings.push({
      conceptId: source.concept.id,
      source: sourcePath,
      targetTypeName,
      typeSchemaHash: entry.typeHash,
      resolvedIr: entry.resolvedIr,
      generatedCodeHash: entry.generatedCodeHash,
    });
  }
  return bindings;
}

function currentVerifiedBinding(
  entry: SemanticLockEntry,
  source: SemanticSource,
): boolean {
  return (
    entry.conceptId === source.concept.id &&
    entry.conceptHash === source.concept.hash &&
    entry.targetTypeName !== undefined &&
    entry.promotion?.validation.candidateTypecheck === "passed" &&
    entry.promotion.validation.projectTypecheck === "passed" &&
    entry.promotion.validation.semanticTest === "passed" &&
    entry.promotion.validation.fullTest === "passed"
  );
}

async function safeWorkspaceFile(
  workspaceRoot: string,
  path: string,
  subject: string,
): Promise<string> {
  const absolute = await realpath(resolve(path));
  const relative = workspaceRelativePath(workspaceRoot, absolute, subject);
  if (secretPath(relative)) {
    throw new Error(`${subject} uses a forbidden secret-like path`);
  }
  return relative;
}

function secretPath(path: string): boolean {
  return path
    .split("/")
    .some((segment) =>
      /(^|[._-])(secret|credential|token|api[-_]?key|private[-_]?key)([._-]|$)/i.test(
        segment,
      ),
    );
}

function excludedSource(path: string): boolean {
  return (
    /(^|\/)(node_modules|\.git|\.semantic)(\/|$)/.test(path) ||
    /(^|\/)\.env(?:\.|$)/.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)(?:fixtures?|__fixtures__)(\/|$)/i.test(path)
  );
}

function boundedDeclaration(value: string, subject: string): string {
  const normalized = value.trim();
  if (
    Buffer.byteLength(normalized, "utf8") >
    PROJECT_CONTEXT_LIMITS.declarationBytes
  ) {
    throw new Error(
      `${subject} exceeds ${PROJECT_CONTEXT_LIMITS.declarationBytes} bytes`,
    );
  }
  return normalized;
}

function typeOnlyDeclaration(
  value: string,
  subject: string,
  expectedName: string,
): string {
  const normalized = boundedDeclaration(value, subject);
  const parsed = ts.createSourceFile(
    "project-context.ts",
    normalized,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const statement = parsed.statements[0];
  if (
    parsed.statements.length !== 1 ||
    statement === undefined ||
    (!ts.isTypeAliasDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement))
  ) {
    throw new Error(
      `${subject} must contain exactly one type alias or interface`,
    );
  }
  if (statement.name.text !== expectedName) {
    throw new Error(
      `${subject} must declare the expected type ${expectedName}`,
    );
  }
  const diagnostics =
    ts.transpileModule(normalized, {
      fileName: "project-context.ts",
      reportDiagnostics: true,
      compilerOptions: { noEmit: true },
    }).diagnostics ?? [];
  if (
    diagnostics.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
  ) {
    throw new Error(`${subject} must be syntactically valid TypeScript`);
  }
  return normalized;
}

function declarationName(
  declaration: ts.Declaration,
  _checker: ts.TypeChecker,
): string {
  const name = (declaration as ts.NamedDeclaration).name;
  if (name !== undefined && name !== null) {
    return name.getText(declaration.getSourceFile());
  }
  return "<anonymous>";
}

function assertTypeOnlyDeclarations(
  declarations: readonly ts.Declaration[],
  subject: string,
): void {
  for (const declaration of declarations) {
    if (
      !ts.isTypeAliasDeclaration(declaration) &&
      !ts.isInterfaceDeclaration(declaration)
    ) {
      throw new Error(
        `${subject} must use a type alias or interface without implementation code`,
      );
    }
  }
}

function compareContextEntry(
  left: { source: string; typeName: string },
  right: { source: string; typeName: string },
): number {
  return (
    left.source.localeCompare(right.source) ||
    left.typeName.localeCompare(right.typeName)
  );
}

function recordValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  assertKnownKeys(value, keys, path);
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) {
    throw new Error(`${path} is missing ${missing}`);
  }
}

function trimmedString(input: unknown, path: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.trim() !== input
  ) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return input;
}

function contextSourcePath(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (
    value.includes("\\") ||
    isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("/../") ||
    value.startsWith("./") ||
    value.endsWith("/")
  ) {
    throw new Error(`${path} must be a normalized relative path`);
  }
  if (secretPath(value) || excludedSource(value)) {
    throw new Error(`${path} uses a forbidden source path`);
  }
  return value;
}

function hashValue(input: unknown, path: string): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/.test(input)) {
    throw new Error(`${path} must be a lowercase SHA-256 hash`);
  }
  return input;
}

function booleanValue(input: unknown, path: string): boolean {
  if (typeof input !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return input;
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
