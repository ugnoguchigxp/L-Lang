import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import ts from "typescript";
import { resolveContainedFile } from "./contained-path";
import {
  type EffectsManifest,
  effectsManifest,
  HostOperationRegistry,
  type OperationDefinition,
} from "./llang-effects-contract";
import type {
  LinearEffectStep,
  LinearEffectsProgram,
} from "./llang-effects-wasm";
import { decodeUtf8, LLANG_SOURCE_BYTES, parseLlangJsonc } from "./llang-jsonc";
import { ModuleError } from "./llang-module-ir";
import { fingerprintFor } from "./stable-hash";
import { digest } from "./wasm-contract";

export type EffectsSourceStep = Readonly<{
  operation: string;
  version: number;
  payload: number;
  combine: "replace" | "add";
}>;
export type EffectsModuleSource = Readonly<{
  language: "l-lang";
  version: 5;
  kind: "module";
  profile: "module-effects-v1";
  module: string;
  entry: string;
  operations: readonly OperationDefinition[];
  initial: number;
  steps: readonly EffectsSourceStep[];
}>;
export type CheckedEffectsModuleProgram = Readonly<{
  source: EffectsModuleSource;
  sourcePath: string;
  sourceHash: string;
  sourceSetHash: string;
  programHash: string;
  interfaceHash: string;
  manifest: EffectsManifest;
  program: LinearEffectsProgram;
}>;

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModuleError("LLE001", `${label} must be an object`);
  return value as Record<string, unknown>;
};
const exact = (value: unknown, keys: string[], label: string) => {
  const result = record(value, label),
    unknown = Object.keys(result).find((key) => !keys.includes(key));
  if (unknown)
    throw new ModuleError("LLE001", `unknown ${label} key ${unknown}`);
  return result;
};
const string = (value: unknown, label: string) => {
  if (typeof value !== "string")
    throw new ModuleError("LLE001", `${label} must be a string`);
  return value;
};
const integer = (value: unknown, label: string) => {
  if (!Number.isInteger(value))
    throw new ModuleError("LLE001", `${label} must be an integer`);
  return value as number;
};
const boolean = (value: unknown, label: string) => {
  if (typeof value !== "boolean")
    throw new ModuleError("LLE001", `${label} must be a boolean`);
  return value;
};
const list = (value: unknown, label: string) => {
  if (!Array.isArray(value))
    throw new ModuleError("LLE001", `${label} must be an array`);
  return value;
};

const operation = (raw: unknown): OperationDefinition => {
  const item = exact(
    raw,
    [
      "id",
      "version",
      "requestType",
      "responseType",
      "errorType",
      "effect",
      "resource",
      "cancellable",
      "idempotent",
    ],
    "operation",
  );
  if (!(["file", "http", "clock", "host"] as unknown[]).includes(item.effect))
    throw new ModuleError("LLE001", "invalid operation effect");
  if (
    !(["none", "file", "http-body", "stream"] as unknown[]).includes(
      item.resource,
    )
  )
    throw new ModuleError("LLE001", "invalid operation resource");
  return {
    id: string(item.id, "operation id"),
    version: integer(item.version, "operation version"),
    requestType: item.requestType,
    responseType: item.responseType,
    errorType: item.errorType,
    effect: item.effect as OperationDefinition["effect"],
    resource: item.resource as OperationDefinition["resource"],
    cancellable: boolean(item.cancellable, "operation cancellable"),
    idempotent: boolean(item.idempotent, "operation idempotent"),
  };
};

const step = (raw: unknown): EffectsSourceStep => {
  const item = exact(
    raw,
    ["operation", "version", "payload", "combine"],
    "effect step",
  );
  if (item.combine !== "replace" && item.combine !== "add")
    throw new ModuleError("LLE001", "invalid effect step combine");
  return {
    operation: string(item.operation, "effect step operation"),
    version: integer(item.version, "effect step version"),
    payload: integer(item.payload, "effect step payload"),
    combine: item.combine,
  };
};

const source = (value: unknown, entry?: string): EffectsModuleSource => {
  const root = exact(
    value,
    [
      "language",
      "version",
      "kind",
      "profile",
      "module",
      "entry",
      "operations",
      "initial",
      "steps",
    ],
    "module",
  );
  if (
    root.language !== "l-lang" ||
    root.version !== 5 ||
    root.kind !== "module" ||
    root.profile !== "module-effects-v1"
  )
    throw new ModuleError("LLE001", "invalid module-effects-v1 header");
  const result: EffectsModuleSource = {
    language: "l-lang",
    version: 5,
    kind: "module",
    profile: "module-effects-v1",
    module: string(root.module, "module name"),
    entry: entry ?? string(root.entry, "entry name"),
    operations: Object.freeze(
      list(root.operations, "operations").map(operation),
    ),
    initial: integer(root.initial, "initial value"),
    steps: Object.freeze(list(root.steps, "steps").map(step)),
  };
  if (entry !== undefined && root.entry !== undefined)
    throw new ModuleError(
      "LLE001",
      "TypeScript definition must not contain entry",
    );
  return Object.freeze(result);
};

export function parseEffectsModuleJsonc(
  text: string,
  file = "<module>",
): EffectsModuleSource {
  const parsed = parseLlangJsonc(text, file);
  if (!parsed.document || !parsed.report.ok)
    throw new ModuleError(
      "LLE001",
      parsed.report.diagnostics[0]?.message ?? "invalid JSONC",
      file,
    );
  return source(parsed.document.value);
}

const literal = (
  node: ts.Expression,
  state = { nodes: 0 },
  depth = 0,
): unknown => {
  state.nodes += 1;
  if (state.nodes > 10_000 || depth > 64)
    throw new ModuleError("LLE001", "TypeScript effects literal is too large");
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text);
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((item) => literal(item, state, depth + 1));
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      )
        throw new ModuleError("LLE001", "unsupported TypeScript property");
      const name = property.name.text;
      if (Object.hasOwn(result, name))
        throw new ModuleError(
          "LLE001",
          `duplicate TypeScript property ${name}`,
        );
      result[name] = literal(property.initializer, state, depth + 1);
    }
    return result;
  }
  throw new ModuleError("LLE001", "unsupported TypeScript effects literal");
};

export function parseEffectsModuleTypeScript(
  text: string,
  file = "<module.ts>",
): EffectsModuleSource {
  const root = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    ),
    imports = root.statements.filter(ts.isImportDeclaration),
    variables = root.statements.filter(ts.isVariableStatement),
    parseDiagnostics = (
      root as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
  if (parseDiagnostics?.length)
    throw new ModuleError("LLE001", "invalid TypeScript syntax", file);
  const importDeclaration = imports[0];
  if (
    root.statements.length !== 2 ||
    imports.length !== 1 ||
    variables.length !== 1 ||
    !importDeclaration ||
    !ts.isStringLiteral(importDeclaration.moduleSpecifier) ||
    importDeclaration.moduleSpecifier.text !== "llang:effects"
  )
    throw new ModuleError(
      "LLE001",
      "invalid module-effects-v1 TypeScript shape",
    );
  const clause = importDeclaration.importClause,
    bindings = clause?.namedBindings;
  if (
    clause?.isTypeOnly ||
    clause?.name ||
    !bindings ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.length !== 1 ||
    bindings.elements[0]?.name.text !== "defineEffects" ||
    bindings.elements[0].propertyName
  )
    throw new ModuleError("LLE001", "invalid llang:effects import");
  const statement = variables[0],
    declaration = statement?.declarationList.declarations[0],
    exported = statement?.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
  if (
    !statement ||
    !exported ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    statement.declarationList.declarations.length !== 1 ||
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !ts.isCallExpression(declaration.initializer) ||
    !ts.isIdentifier(declaration.initializer.expression) ||
    declaration.initializer.expression.text !== "defineEffects" ||
    declaration.initializer.arguments.length !== 1
  )
    throw new ModuleError("LLE001", "invalid exported effects definition");
  const value = literal(declaration.initializer.arguments[0] as ts.Expression);
  return source(
    {
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      ...record(value, "effects definition"),
    },
    declaration.name.text,
  );
}

const checkedI32 = (value: number, label: string) => {
  if (value < -2147483648 || value > 2147483647)
    throw new ModuleError("LLE002", `${label} is outside i32`);
  return value;
};
const MODULE_ID = /^[a-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)*$/;
const ENTRY_ID = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function checkEffectsModule(
  input: EffectsModuleSource,
  sourcePath: string,
  sourceHash: string,
  sourceIdentity = sourcePath,
): CheckedEffectsModuleProgram {
  if (
    !input.module ||
    !input.entry ||
    input.module.length > 256 ||
    input.entry.length > 128 ||
    !MODULE_ID.test(input.module) ||
    !ENTRY_ID.test(input.entry) ||
    !input.operations.length ||
    input.operations.length > 1024 ||
    !input.steps.length ||
    input.steps.length > 1024
  )
    throw new ModuleError("LLE002", "invalid effects module structure");
  checkedI32(input.initial, "initial");
  const registry = new HostOperationRegistry(input.operations),
    requirements = input.steps.map(({ operation, version }) => ({
      id: operation,
      version,
    })),
    manifest = effectsManifest(registry, requirements),
    index = new Map(
      manifest.operations.map((item, position) => [
        `${item.id}@${item.version}`,
        position,
      ]),
    ),
    steps: LinearEffectStep[] = input.steps.map((item) => {
      const operationIndex = index.get(`${item.operation}@${item.version}`);
      if (operationIndex === undefined)
        throw new ModuleError("LLE002", `unknown operation ${item.operation}`);
      return {
        operation: operationIndex,
        payload: checkedI32(item.payload, "effect payload"),
        combine: item.combine,
      };
    }),
    program = Object.freeze({
      initial: checkedI32(input.initial, "initial"),
      steps: Object.freeze(steps),
    }),
    programHash = fingerprintFor({ source: input, program, manifest }),
    interfaceHash = fingerprintFor({
      profile: input.profile,
      entry: input.entry,
      result: "i32",
      effects: manifest.effects,
      operations: manifest.operations,
    });
  return Object.freeze({
    source: input,
    sourcePath,
    sourceHash,
    sourceSetHash: fingerprintFor([{ path: sourceIdentity, hash: sourceHash }]),
    programHash,
    interfaceHash,
    manifest,
    program,
  });
}

export async function loadEffectsModuleProgram(
  entry: string,
  root: string,
  entryName: string,
): Promise<CheckedEffectsModuleProgram> {
  const canonicalRoot = resolve(root),
    path = await resolveContainedFile(canonicalRoot, entry, "effects source", {
      rejectSymbolicLinks: true,
    }),
    bytes = await readFile(path);
  if (bytes.length > LLANG_SOURCE_BYTES)
    throw new ModuleError("LLE001", "effects source exceeds byte limit", path);
  const text = decodeUtf8(bytes, path),
    extension = extname(path),
    parsed =
      extension === ".ts"
        ? parseEffectsModuleTypeScript(text, path)
        : extension === ".jsonc"
          ? parseEffectsModuleJsonc(text, path)
          : (() => {
              throw new ModuleError(
                "LLE001",
                "unsupported effects source extension",
              );
            })();
  if (parsed.entry !== entryName)
    throw new ModuleError("LLE002", `entry ${entryName} was not found`, path);
  return checkEffectsModule(
    parsed,
    path,
    digest(bytes),
    relative(canonicalRoot, path).replaceAll("\\", "/"),
  );
}
