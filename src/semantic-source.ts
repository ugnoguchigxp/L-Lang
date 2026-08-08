import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import ts from "typescript";

import {
  parseConceptSpecification,
  validateConceptSpecificationForUse,
  type ConceptSpecificationUse,
  type StructuredConceptSpecification,
} from "./concept-specification";
import {
  assertCounterfactualCases,
  assertInvarianceCases,
  assertNamedSemanticCases,
  assertNonEmptyStaticArray,
  assertObjectPropertyKeys,
  findArrayProperty,
  findOptionalArrayProperty,
} from "./semantic-source-cases";
import {
  formatDiagnostics,
  SemanticSourceError,
  sourceError,
} from "./semantic-source-diagnostics";
import {
  buildTypeSchema,
  findTypeDeclaration,
  type TypeSchema,
} from "./semantic-source-type-schema";

export {
  formatDiagnostics,
  SemanticSourceError,
  sourceError,
} from "./semantic-source-diagnostics";
export type { TypeSchema } from "./semantic-source-type-schema";

export type SemanticSourceBase = {
  absolutePath: string;
  sourceText: string;
  sourceFile: ts.SourceFile;
  program: ts.Program;
  checker: ts.TypeChecker;
  concept: {
    name: string;
    id: string;
    hash: string;
    shared: boolean;
    definitionName: string;
    definitionPath: string;
    specification: string;
    structure: StructuredConceptSpecification;
    inputType: ts.Type;
    typeName: string;
    typeDeclaration: string;
    typeSchema: TypeSchema;
    node: ts.Node;
  };
  predicate: {
    name: string;
    conceptName: string;
    parameterName: string;
  };
};

export type SemanticSource = SemanticSourceBase & {
  sourceForm: "semantic-test";
  tests: {
    predicateName: string;
    acceptSource: string;
    rejectSource: string;
    boundarySource: string | null;
    counterfactualSource: string | null;
    invarianceSource: string | null;
  };
};

export type BenchmarkSemanticSource = SemanticSourceBase & {
  sourceForm: "benchmark-probe";
  probe: {
    predicateName: string;
  };
};

export async function scanSemanticSource(
  sourcePath: string,
): Promise<SemanticSource> {
  const source = await scanPredicateSource(sourcePath, "semantic-test");
  if (source.sourceForm !== "semantic-test") {
    throw new SemanticSourceError("internal error: expected a semantic-test source");
  }
  return source;
}

export async function scanBenchmarkSource(
  sourcePath: string,
): Promise<BenchmarkSemanticSource> {
  const source = await scanPredicateSource(sourcePath, "benchmark-probe");
  if (source.sourceForm !== "benchmark-probe") {
    throw new SemanticSourceError("internal error: expected a benchmark-probe source");
  }
  return source;
}

async function scanPredicateSource(
  sourcePath: string,
  expectedForm: "semantic-test" | "benchmark-probe",
): Promise<SemanticSource | BenchmarkSemanticSource> {
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
  const concepts: SemanticSourceBase["concept"][] = [];
  const predicates: SemanticSourceBase["predicate"][] = [];
  const tests: SemanticSource["tests"][] = [];
  const probes: BenchmarkSemanticSource["probe"][] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) {
          continue;
        }

        const initializer = declaration.initializer;
        if (
          ts.isTaggedTemplateExpression(initializer) &&
          ts.isIdentifier(initializer.tag) &&
          initializer.tag.text === "concept"
        ) {
          const typeArguments = initializer.typeArguments;
          if (typeArguments === undefined || typeArguments.length !== 1) {
            throw sourceError(sourceFile, initializer, "concept requires exactly one type argument");
          }
          if (!ts.isNoSubstitutionTemplateLiteral(initializer.template)) {
            throw sourceError(sourceFile, initializer, "concept template substitutions are not supported");
          }

          const [typeNode] = typeArguments;
          if (typeNode === undefined) {
            throw sourceError(sourceFile, initializer, "concept requires exactly one type argument");
          }
          if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
            throw sourceError(sourceFile, typeNode, "concept input must be a named TypeScript type");
          }
          const inputType = checker.getTypeFromTypeNode(typeNode);
          const typeName = typeNode.typeName.text;
          const conceptId = `local:${declaration.name.text}`;
          const parsedSpecification = parseConceptSpecificationAt(
            initializer.template.text,
            sourceFile,
            initializer.template,
            "predicate",
          );
          const specification = parsedSpecification.specification;
          concepts.push({
            name: declaration.name.text,
            id: conceptId,
            hash: hashConcept(conceptId, specification),
            shared: false,
            definitionName: declaration.name.text,
            definitionPath: sourceFile.fileName,
            specification,
            structure: parsedSpecification.structure,
            inputType,
            typeName,
            typeDeclaration: findTypeDeclaration(inputType, sourceFile),
            typeSchema: buildTypeSchema(inputType, checker, initializer, 0),
            node: initializer,
          });
          continue;
        }

        if (
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === "bindConcept"
        ) {
          const typeArguments = initializer.typeArguments;
          if (typeArguments === undefined || typeArguments.length !== 1) {
            throw sourceError(sourceFile, initializer, "bindConcept requires exactly one type argument");
          }
          const [conceptArgument] = initializer.arguments;
          if (
            initializer.arguments.length !== 1 ||
            conceptArgument === undefined ||
            !ts.isIdentifier(conceptArgument)
          ) {
            throw sourceError(sourceFile, initializer, "bindConcept requires one concept definition identifier");
          }

          const [typeNode] = typeArguments;
          if (typeNode === undefined) {
            throw sourceError(sourceFile, initializer, "bindConcept requires exactly one type argument");
          }
          if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
            throw sourceError(sourceFile, typeNode, "bindConcept input must be a named TypeScript type");
          }
          const definition = resolveConceptDefinition(
            conceptArgument,
            checker,
            sourceFile,
            "predicate",
          );
          const inputType = checker.getTypeFromTypeNode(typeNode);
          const typeName = typeNode.typeName.text;
          concepts.push({
            name: declaration.name.text,
            id: definition.id,
            hash: hashConcept(definition.id, definition.specification),
            shared: true,
            definitionName: definition.name,
            definitionPath: definition.sourceFile.fileName,
            specification: definition.specification,
            structure: definition.structure,
            inputType,
            typeName,
            typeDeclaration: findTypeDeclaration(inputType, sourceFile),
            typeSchema: buildTypeSchema(inputType, checker, initializer, 0),
            node: initializer,
          });
          continue;
        }

        if (
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === "generatePredicate"
        ) {
          const [conceptArgument] = initializer.arguments;
          if (
            initializer.arguments.length !== 1 ||
            conceptArgument === undefined ||
            !ts.isIdentifier(conceptArgument)
          ) {
            throw sourceError(sourceFile, initializer, "generatePredicate requires one concept identifier");
          }
          predicates.push({
            name: declaration.name.text,
            conceptName: conceptArgument.text,
            parameterName: lowerFirst(typeNameFromConceptReference(conceptArgument.text, concepts)),
          });
        }
      }
      continue;
    }

    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression)
    ) {
      const call = statement.expression;
      if (!ts.isIdentifier(call.expression)) continue;
      const callName = call.expression.text;
      if (callName === "benchmarkProbe") {
        const [predicateArgument] = call.arguments;
        if (
          call.arguments.length !== 1 ||
          predicateArgument === undefined ||
          !ts.isIdentifier(predicateArgument)
        ) {
          throw sourceError(
            sourceFile,
            call,
            "benchmarkProbe requires exactly one predicate",
          );
        }
        probes.push({ predicateName: predicateArgument.text });
        continue;
      }
      if (callName !== "semanticTest") continue;
      const [predicateArgument, caseArgument] = call.arguments;
      if (
        call.arguments.length !== 2 ||
        predicateArgument === undefined ||
        caseArgument === undefined ||
        !ts.isIdentifier(predicateArgument) ||
        !ts.isObjectLiteralExpression(caseArgument)
      ) {
        throw sourceError(sourceFile, call, "semanticTest requires a predicate and a case object");
      }
      const caseObject = caseArgument;
      assertObjectPropertyKeys(
        caseObject,
        ["accept", "reject", "boundary", "counterfactual", "invariance"],
        "semanticTest",
        sourceFile,
      );
      const accept = findArrayProperty(caseObject, "accept", sourceFile);
      const reject = findArrayProperty(caseObject, "reject", sourceFile);
      assertNonEmptyStaticArray(accept, "accept", sourceFile);
      assertNonEmptyStaticArray(reject, "reject", sourceFile);
      const boundary = findOptionalArrayProperty(
        caseObject,
        "boundary",
        sourceFile,
      );
      const counterfactual = findOptionalArrayProperty(
        caseObject,
        "counterfactual",
        sourceFile,
      );
      const invariance = findOptionalArrayProperty(
        caseObject,
        "invariance",
        sourceFile,
      );
      if (boundary !== null) {
        assertNamedSemanticCases(boundary, "semanticTest.boundary", sourceFile);
      }
      if (counterfactual !== null) {
        assertCounterfactualCases(counterfactual, sourceFile);
      }
      if (invariance !== null) {
        assertInvarianceCases(invariance, sourceFile);
      }
      tests.push({
        predicateName: predicateArgument.text,
        acceptSource: accept.getText(sourceFile),
        rejectSource: reject.getText(sourceFile),
        boundarySource: boundary?.getText(sourceFile) ?? null,
        counterfactualSource: counterfactual?.getText(sourceFile) ?? null,
        invarianceSource: invariance?.getText(sourceFile) ?? null,
      });
    }
  }

  if (expectedForm === "semantic-test" && probes.length > 0) {
    throw new SemanticSourceError(
      "benchmarkProbe is restricted to research benchmark runners",
    );
  }
  if (expectedForm === "benchmark-probe" && tests.length > 0) {
    throw new SemanticSourceError(
      "research benchmark sources must use benchmarkProbe instead of semanticTest",
    );
  }

  const formCount = expectedForm === "semantic-test" ? tests.length : probes.length;
  if (concepts.length !== 1 || predicates.length !== 1 || formCount !== 1) {
    const formName = expectedForm === "semantic-test"
      ? "semanticTest"
      : "benchmarkProbe";
    throw new SemanticSourceError(
      `MVP requires exactly one concept, one generated predicate, and one ${formName}; found ${concepts.length}/${predicates.length}/${formCount}`,
    );
  }

  const [conceptValue] = concepts;
  const [predicate] = predicates;
  if (conceptValue === undefined || predicate === undefined) {
    throw new SemanticSourceError("semantic source cardinality validation failed");
  }
  predicate.parameterName = lowerFirst(conceptValue.typeName);

  if (predicate.conceptName !== conceptValue.name) {
    throw new SemanticSourceError(
      `semantic closure failed: ${predicate.name} references unknown concept ${predicate.conceptName}`,
    );
  }
  const selectedForm = expectedForm === "semantic-test" ? tests[0] : probes[0];
  if (selectedForm === undefined) {
    throw new SemanticSourceError("semantic source form validation failed");
  }
  const formPredicateName = selectedForm.predicateName;
  const formName = expectedForm === "semantic-test"
    ? "semanticTest"
    : "benchmarkProbe";
  if (formPredicateName !== predicate.name) {
    throw new SemanticSourceError(
      `semantic closure failed: ${formName} references ${formPredicateName}, expected ${predicate.name}`,
    );
  }

  const base: SemanticSourceBase = {
    absolutePath,
    sourceText,
    sourceFile,
    program,
    checker,
    concept: conceptValue,
    predicate,
  };
  if (expectedForm === "semantic-test") {
    const [test] = tests;
    if (test === undefined) {
      throw new SemanticSourceError("semantic test validation failed");
    }
    return { ...base, sourceForm: "semantic-test", tests: test };
  }
  const [probe] = probes;
  if (probe === undefined) {
    throw new SemanticSourceError("benchmark probe validation failed");
  }
  return { ...base, sourceForm: "benchmark-probe", probe };
}

export function resolveConceptDefinition(
  reference: ts.Identifier,
  checker: ts.TypeChecker,
  bindingSourceFile: ts.SourceFile,
  use: ConceptSpecificationUse,
): {
  id: string;
  name: string;
  specification: string;
  structure: StructuredConceptSpecification;
  sourceFile: ts.SourceFile;
} {
  const referenceSymbol = checker.getSymbolAtLocation(reference);
  if (referenceSymbol === undefined) {
    throw sourceError(bindingSourceFile, reference, `cannot resolve concept definition ${reference.text}`);
  }
  const symbol = referenceSymbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(referenceSymbol)
    : referenceSymbol;
  const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
  if (
    declaration === undefined ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined ||
    !ts.isTaggedTemplateExpression(declaration.initializer)
  ) {
    throw sourceError(
      bindingSourceFile,
      reference,
      `${reference.text} must resolve to a defineConcept declaration`,
    );
  }

  const tagged = declaration.initializer;
  if (!ts.isCallExpression(tagged.tag)) {
    throw sourceError(
      bindingSourceFile,
      reference,
      `${reference.text} must use defineConcept("stable.id")`,
    );
  }
  const [idArgument] = tagged.tag.arguments;
  if (
    !ts.isIdentifier(tagged.tag.expression) ||
    tagged.tag.expression.text !== "defineConcept" ||
    tagged.tag.arguments.length !== 1 ||
    idArgument === undefined ||
    !ts.isStringLiteral(idArgument)
  ) {
    throw sourceError(
      bindingSourceFile,
      reference,
      `${reference.text} must use defineConcept("stable.id")`,
    );
  }
  if (!ts.isNoSubstitutionTemplateLiteral(tagged.template)) {
    throw sourceError(
      bindingSourceFile,
      reference,
      "defineConcept template substitutions are not supported",
    );
  }

  const id = idArgument.text;
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) {
    throw sourceError(
      bindingSourceFile,
      reference,
      `concept ID must be a stable lowercase dotted identifier: ${id}`,
    );
  }

  const parsedSpecification = parseConceptSpecificationAt(
    tagged.template.text,
    tagged.getSourceFile(),
    tagged.template,
    use,
  );
  return {
    id,
    name: declaration.name.text,
    specification: parsedSpecification.specification,
    structure: parsedSpecification.structure,
    sourceFile: declaration.getSourceFile(),
  };
}

function parseConceptSpecificationAt(
  specification: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  use: ConceptSpecificationUse,
): ReturnType<typeof parseConceptSpecification> {
  try {
    const parsed = parseConceptSpecification(specification);
    validateConceptSpecificationForUse(parsed.structure, use);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw sourceError(sourceFile, node, message);
  }
}

function typeNameFromConceptReference(
  conceptName: string,
  concepts: SemanticSource["concept"][],
): string {
  return concepts.find((candidate) => candidate.name === conceptName)?.typeName ?? "value";
}

function lowerFirst(value: string): string {
  const first = value.at(0);
  return first === undefined ? "value" : first.toLowerCase() + value.slice(1);
}

export function hashConcept(id: string, specification: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ id, specification }))
    .digest("hex");
}
