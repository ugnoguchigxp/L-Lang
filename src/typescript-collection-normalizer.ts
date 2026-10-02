import { dirname, resolve } from "node:path";
import ts from "typescript";
import { ModuleError } from "./llang-module-ir";

// This pass only changes surface syntax. All types, effects and resource limits
// are still checked by the collection IR checker and existing native backend.
export function normalizeCollectionTypeScript(
  text: string,
  file: string,
  sources: ReadonlyMap<string, string> = new Map(),
): string {
  const path = resolve(file),
    corePath = resolve("/__llang_collection_core__.d.ts"),
    libPath = resolve("/__llang_collection_lib__.d.ts"),
    files = new Map(sources);
  files.set(path, text);
  files.set(
    libPath,
    `interface Array<T> extends ReadonlyArray<T> { [n: number]: T; }
     interface ReadonlyArray<T> {
       readonly length: number; readonly [n: number]: T;
       map<U>(callback: (value: T) => U): U[];
       filter(callback: (value: T) => boolean): T[];
       reduce<U>(callback: (sum: U, value: T) => U, initial: U): U;
     }`,
  );
  files.set(corePath, "export type List<T> = ReadonlyArray<T>;");
  const options: ts.CompilerOptions = {
      noLib: true,
      noEmit: true,
      strict: true,
      types: [],
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
    host: ts.CompilerHost = {
      getSourceFile: (name) => {
        const source = files.get(resolve(name));
        return source === undefined
          ? undefined
          : ts.createSourceFile(name, source, ts.ScriptTarget.ESNext, true);
      },
      getDefaultLibFileName: () => libPath,
      writeFile: () => {},
      getCurrentDirectory: () => dirname(path),
      getDirectories: () => [],
      fileExists: (name) => files.has(resolve(name)),
      readFile: (name) => files.get(resolve(name)),
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      resolveModuleNames: (names, containing) =>
        names.map((name) => {
          const target =
            name === "llang:core"
              ? corePath
              : resolve(dirname(containing), name);
          return files.has(target)
            ? { resolvedFileName: target, extension: ts.Extension.Ts }
            : undefined;
        }),
    },
    program = ts.createProgram([path, libPath], options, host),
    source = program.getSourceFile(path);
  if (!source) throw new ModuleError("LLC008", "source is required", file);
  const diagnostic = (
    source as ts.SourceFile & {
      parseDiagnostics: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics[0];
  if (diagnostic)
    throw new ModuleError(
      "LLC008",
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      file,
    );
  const checker = program.getTypeChecker(),
    generatedImports = new Set<string>(),
    renamed = new Map<ts.Symbol, string>(),
    identifiers = new Set<string>(),
    bindings = new Set<string>();
  let nextLoop = 0;
  const fail: (message: string) => never = (message) => {
    throw new ModuleError("LLC008", message, file);
  };
  const scan = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isImportSpecifier(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      bindings.add(node.name.text);
    ts.forEachChild(node, scan);
  };
  scan(source);
  const fresh = (prefix: string): string => {
    let name: string;
    do name = `__llang_${prefix}_${nextLoop++}`;
    while (identifiers.has(name));
    identifiers.add(name);
    return name;
  };
  const arrayElement = (node: ts.Expression): ts.Type | undefined => {
    const type = checker.getTypeAtLocation(node);
    return checker.isArrayType(type)
      ? checker.getTypeArguments(type as ts.TypeReference)[0]
      : undefined;
  };
  const intrinsic = (name: string, args: ts.Expression[]) => {
    generatedImports.add(name);
    return ts.factory.createCallExpression(
      ts.factory.createIdentifier(name),
      undefined,
      args,
    );
  };
  const update = (expression: ts.Expression): ts.Statement => {
    let left: ts.Identifier, right: ts.Expression, operator: ts.BinaryOperator;
    if (
      (ts.isPostfixUnaryExpression(expression) ||
        ts.isPrefixUnaryExpression(expression)) &&
      (expression.operator === ts.SyntaxKind.PlusPlusToken ||
        expression.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(expression.operand)
    ) {
      left = expression.operand;
      operator =
        expression.operator === ts.SyntaxKind.PlusPlusToken
          ? ts.SyntaxKind.PlusToken
          : ts.SyntaxKind.MinusToken;
      right = ts.factory.createNumericLiteral(1);
    } else if (
      ts.isBinaryExpression(expression) &&
      ts.isIdentifier(expression.left)
    ) {
      const operators = new Map<ts.SyntaxKind, ts.BinaryOperator>([
        [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.PlusToken],
        [ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.MinusToken],
        [ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskToken],
        [ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.SlashToken],
        [ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.PercentToken],
      ]);
      const op = operators.get(expression.operatorToken.kind);
      if (!op) return ts.factory.createExpressionStatement(expression);
      left = expression.left;
      right = expression.right;
      operator = op;
    } else return ts.factory.createExpressionStatement(expression);
    return ts.factory.createExpressionStatement(
      ts.factory.createAssignment(
        left,
        ts.factory.createBinaryExpression(left, operator, right),
      ),
    );
  };
  const terminates = (node: ts.Statement | undefined): boolean => {
    if (!node) return false;
    if (
      ts.isReturnStatement(node) ||
      ts.isBreakStatement(node) ||
      ts.isContinueStatement(node)
    )
      return true;
    if (ts.isBlock(node)) return terminates(node.statements.at(-1));
    if (ts.isIfStatement(node))
      return terminates(node.thenStatement) && terminates(node.elseStatement);
    if (ts.isSwitchStatement(node))
      return (
        node.caseBlock.clauses.length > 0 &&
        node.caseBlock.clauses.every(
          (clause) =>
            !ts.isBreakStatement(clause.statements.at(-1) ?? node) &&
            terminates(clause.statements.at(-1)),
        )
      );
    return false;
  };
  const transformed = ts.transform(source, [
    (context) => {
      const f = context.factory;
      const visit: ts.Visitor = (node) => {
        if (ts.isCallExpression(node) && node.questionDotToken)
          fail("optional calls are unsupported");
        if (ts.isNonNullExpression(node))
          return ts.visitNode(node.expression, visit);
        if (ts.isIdentifier(node)) {
          const symbol = checker.getSymbolAtLocation(node),
            name = symbol && renamed.get(symbol);
          if (name) return f.createIdentifier(name);
        }
        if (ts.isShorthandPropertyAssignment(node)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(node),
            name = symbol && renamed.get(symbol);
          if (name)
            return f.createPropertyAssignment(
              node.name,
              f.createIdentifier(name),
            );
        }
        if (
          ts.isObjectLiteralExpression(node) ||
          ts.isArrayLiteralExpression(node)
        ) {
          const contextual = checker.getContextualType(node),
            type =
              contextual &&
              checker.typeToTypeNode(
                contextual,
                node,
                ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope,
              );
          if (
            type &&
            (ts.isTypeReferenceNode(type) || ts.isArrayTypeNode(type))
          )
            return f.createAsExpression(
              ts.isObjectLiteralExpression(node)
                ? f.updateObjectLiteralExpression(
                    node,
                    node.properties.map((property) => {
                      const tag =
                        contextual &&
                        checker.getPropertyOfType(contextual, "tag");
                      // A string-valued record field is not a union discriminant.
                      if (
                        tag &&
                        ts.isPropertyAssignment(property) &&
                        (ts.isIdentifier(property.name) ||
                          ts.isStringLiteral(property.name)) &&
                        property.name.text === "tag" &&
                        ts.isStringLiteral(property.initializer) &&
                        checker.getTypeOfSymbolAtLocation(tag, node).flags &
                          ts.TypeFlags.String
                      )
                        return f.updatePropertyAssignment(
                          property,
                          property.name,
                          f.createParenthesizedExpression(property.initializer),
                        );
                      return ts.visitNode(
                        property,
                        visit,
                      ) as ts.ObjectLiteralElementLike;
                    }),
                  )
                : ts.visitEachChild(node, visit, context),
              ts.visitNode(type, visit) as ts.TypeNode,
            );
        }
        if (ts.isInterfaceDeclaration(node)) {
          if (node.heritageClauses?.length)
            fail("interface inheritance is unsupported; use a named record");
          return ts.visitEachChild(
            f.createTypeAliasDeclaration(
              node.modifiers,
              node.name,
              node.typeParameters,
              f.createTypeLiteralNode(node.members),
            ),
            visit,
            context,
          );
        }
        if (ts.isArrayTypeNode(node)) {
          generatedImports.add("List");
          return f.createTypeReferenceNode("List", [
            ts.visitNode(node.elementType, visit) as ts.TypeNode,
          ]);
        }
        if (
          ts.isTypeOperatorNode(node) &&
          node.operator === ts.SyntaxKind.ReadonlyKeyword &&
          ts.isArrayTypeNode(node.type)
        )
          return ts.visitNode(node.type, visit);
        if (
          ts.isTypeReferenceNode(node) &&
          ts.isIdentifier(node.typeName) &&
          ["Array", "ReadonlyArray"].includes(node.typeName.text)
        ) {
          const symbol = checker.getSymbolAtLocation(node.typeName);
          if (
            symbol?.declarations?.some(
              (declaration) =>
                resolve(declaration.getSourceFile().fileName) !== libPath,
            )
          )
            fail("Array and ReadonlyArray cannot be redefined");
          if (node.typeArguments?.length !== 1)
            fail("Array requires exactly one element type");
          generatedImports.add("List");
          return f.createTypeReferenceNode(
            "List",
            node.typeArguments?.map(
              (type) => ts.visitNode(type, visit) as ts.TypeNode,
            ),
          );
        }
        if (ts.isPropertyAccessExpression(node) && node.questionDotToken)
          fail("optional chaining is unsupported");
        if (ts.isElementAccessExpression(node)) {
          if (node.questionDotToken) fail("optional chaining is unsupported");
          if (!arrayElement(node.expression))
            fail("indexed access requires a statically known Array or List");
          return intrinsic("at", [
            ts.visitNode(node.expression, visit) as ts.Expression,
            ts.visitNode(node.argumentExpression, visit) as ts.Expression,
          ]);
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === "length" &&
          arrayElement(node.expression)
        )
          return intrinsic("length", [
            ts.visitNode(node.expression, visit) as ts.Expression,
          ]);
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["map", "filter", "reduce"].includes(node.expression.name.text) &&
          arrayElement(node.expression.expression)
        ) {
          if (node.questionDotToken || node.expression.questionDotToken)
            fail("optional calls are unsupported");
          if (node.typeArguments?.length)
            fail("array methods infer type arguments from typed callbacks");
          const name = node.expression.name.text,
            args = node.arguments.map(
              (arg) => ts.visitNode(arg, visit) as ts.Expression,
            ),
            base = ts.visitNode(
              node.expression.expression,
              visit,
            ) as ts.Expression;
          if (args.length !== (name === "reduce" ? 2 : 1))
            fail(
              `${name} requires a callback${name === "reduce" ? " and initial value" : ""}`,
            );
          if (name === "reduce") {
            // JS evaluates receiver, callback and initial value in that order;
            // fold takes the initial value before its callback.
            const originals = [node.expression.expression, ...node.arguments],
              names = originals.map(() => fresh("reduce")),
              parameters = originals.map((expression, index) => {
                const type = checker.typeToTypeNode(
                  checker.getBaseTypeOfLiteralType(
                    checker.getTypeAtLocation(expression),
                  ),
                  expression,
                  ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope,
                );
                if (!type)
                  fail("reduce requires statically known argument types");
                return f.createParameterDeclaration(
                  undefined,
                  undefined,
                  names[index] as string,
                  undefined,
                  ts.visitNode(type, visit) as ts.TypeNode,
                );
              }),
              returns = checker.typeToTypeNode(
                checker.getBaseTypeOfLiteralType(
                  checker.getTypeAtLocation(node),
                ),
                node,
                ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope,
              );
            if (!returns)
              fail("reduce requires a statically known result type");
            return f.createCallExpression(
              f.createParenthesizedExpression(
                f.createArrowFunction(
                  undefined,
                  undefined,
                  parameters,
                  ts.visitNode(returns, visit) as ts.TypeNode,
                  undefined,
                  intrinsic(
                    "fold",
                    [names[0], names[2], names[1]].map((value) =>
                      f.createIdentifier(value as string),
                    ),
                  ),
                ),
              ),
              undefined,
              [base, ...args],
            );
          }
          return intrinsic(name, [base, args[0] as ts.Expression]);
        }
        if (ts.isSwitchStatement(node)) {
          const clauses = node.caseBlock.clauses.map((clause) => {
            const last = clause.statements.at(-1);
            if (!terminates(last))
              fail(
                "switch fallthrough is unsupported; end each case with break, continue or return",
              );
            const inspectBreak: ts.Visitor = (child) => {
              if (ts.isBreakStatement(child) && !child.label && child !== last)
                fail("switch break must be the final statement of its case");
              if (
                ts.isIterationStatement(child, false) ||
                ts.isSwitchStatement(child) ||
                ts.isFunctionLike(child)
              )
                return child;
              return ts.visitEachChild(child, inspectBreak, context);
            };
            for (const statement of clause.statements)
              ts.visitNode(statement, inspectBreak);
            const body =
              last && ts.isBreakStatement(last) && !last.label
                ? clause.statements.slice(0, -1)
                : clause.statements;
            return ts.isCaseClause(clause)
              ? f.updateCaseClause(
                  clause,
                  ts.visitNode(clause.expression, visit) as ts.Expression,
                  body.map(
                    (statement) =>
                      ts.visitNode(statement, visit) as ts.Statement,
                  ),
                )
              : f.updateDefaultClause(
                  clause,
                  body.map(
                    (statement) =>
                      ts.visitNode(statement, visit) as ts.Statement,
                  ),
                );
          });
          return f.updateSwitchStatement(
            node,
            ts.visitNode(node.expression, visit) as ts.Expression,
            f.updateCaseBlock(node.caseBlock, clauses),
          );
        }
        if (ts.isForOfStatement(node)) {
          if (node.awaitModifier) fail("for-await is unsupported");
          const initializer = node.initializer;
          if (!ts.isVariableDeclarationList(initializer))
            fail("for-of requires a const binding");
          const declaration = initializer.declarations[0];
          if (declaration && !declaration.type) {
            const element = arrayElement(node.expression),
              type =
                element &&
                checker.typeToTypeNode(
                  element,
                  declaration,
                  ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope,
                );
            if (!type) fail("for-of requires a statically known element type");
            const typed = f.updateVariableDeclaration(
              declaration,
              declaration.name,
              declaration.exclamationToken,
              type,
              declaration.initializer,
            );
            return ts.visitEachChild(
              f.updateForOfStatement(
                node,
                undefined,
                f.updateVariableDeclarationList(initializer, [typed]),
                node.expression,
                node.statement,
              ),
              visit,
              context,
            );
          }
        }
        if (ts.isForStatement(node)) {
          if (
            !node.initializer ||
            !ts.isVariableDeclarationList(node.initializer)
          )
            fail("for requires one typed let or const initializer");
          for (const declaration of node.initializer.declarations) {
            if (!ts.isIdentifier(declaration.name))
              fail("for binding must be named");
            const symbol = checker.getSymbolAtLocation(declaration.name);
            if (!symbol) fail("for binding could not be resolved");
            const name = fresh("for");
            renamed.set(symbol, name);
          }
          const increment =
            node.incrementor &&
            (ts.visitNode(update(node.incrementor), visit) as ts.Statement);
          const continueVisitor: ts.Visitor = (child) => {
            if (ts.isContinueStatement(child) && !child.label && increment)
              return f.createBlock([increment, child], true);
            if (
              ts.isForStatement(child) ||
              ts.isForOfStatement(child) ||
              ts.isWhileStatement(child) ||
              ts.isDoStatement(child) ||
              ts.isFunctionLike(child)
            )
              return child;
            return ts.visitEachChild(child, continueVisitor, context);
          };
          const originalBody = ts.visitNode(
              node.statement,
              continueVisitor,
            ) as ts.Statement,
            loopBody = ts.visitNode(originalBody, visit) as ts.Statement,
            body = ts.isBlock(loopBody) ? [...loopBody.statements] : [loopBody];
          if (increment && !terminates(originalBody)) body.push(increment);
          return f.createBlock(
            [
              ts.visitNode(
                f.createVariableStatement(undefined, node.initializer),
                visit,
              ) as ts.Statement,
              f.createWhileStatement(
                node.condition
                  ? (ts.visitNode(node.condition, visit) as ts.Expression)
                  : f.createTrue(),
                f.createBlock(body, true),
              ),
            ],
            true,
          );
        }
        if (ts.isExpressionStatement(node))
          return ts.visitEachChild(update(node.expression), visit, context);
        return ts.visitEachChild(node, visit, context);
      };
      return (root) => ts.visitNode(root, visit) as ts.SourceFile;
    },
  ]);
  try {
    const root = transformed.transformed[0];
    if (!root) fail("source normalization failed");
    const imported = new Set<string>();
    for (const statement of source.statements)
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "llang:core" &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      )
        for (const element of statement.importClause.namedBindings.elements)
          imported.add(element.name.text);
    const additions = [...generatedImports].filter(
      (name) => !imported.has(name),
    );
    // A generated intrinsic must never capture a user binding of the same name.
    for (const name of additions)
      if (bindings.has(name))
        fail(`generated core binding conflicts with ${name}`);
    for (const name of imported) {
      const inspect = (node: ts.Node): void => {
        if (
          !ts.isImportSpecifier(node) &&
          (ts.isVariableDeclaration(node) ||
            ts.isParameter(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isInterfaceDeclaration(node)) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.name.text === name
        )
          fail(`generated core binding conflicts with ${name}`);
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
    const prefix = additions.length
      ? `import { ${additions.sort().join(", ")} } from "llang:core";\n`
      : "";
    return prefix + ts.createPrinter().printFile(root);
  } finally {
    transformed.dispose();
  }
}
