import ts from "typescript";

import { SemanticSourceError } from "./semantic-source-diagnostics";

export type TypeSchema =
  | { kind: "string" | "number" | "boolean" | "null" | "undefined" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "union"; types: TypeSchema[] }
  | { kind: "array"; elementType: TypeSchema }
  | {
      kind: "object";
      properties: Array<{
        name: string;
        optional: boolean;
        type: TypeSchema;
      }>;
    };

export function findTypeDeclaration(
  type: ts.Type,
  sourceFile: ts.SourceFile,
): string {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const declaration = symbol?.declarations?.find(
    (candidate) =>
      ts.isTypeAliasDeclaration(candidate) ||
      ts.isInterfaceDeclaration(candidate),
  );
  if (declaration === undefined) {
    throw new SemanticSourceError(
      "concept input type must have a type alias or interface declaration",
    );
  }
  if (declaration.getSourceFile() !== sourceFile) {
    throw new SemanticSourceError(
      "concept input type must be declared in the semantic source file",
    );
  }
  return declaration.getText(sourceFile);
}

export function buildTypeSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node,
  depth: number,
): TypeSchema {
  if (depth > 3) {
    throw new SemanticSourceError(
      "concept input type nesting exceeds the MVP limit",
    );
  }
  if (type.isUnion()) {
    return {
      kind: "union",
      types: type.types.map((part) =>
        buildTypeSchema(part, checker, location, depth + 1),
      ),
    };
  }
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return { kind: "literal", value: (type as ts.StringLiteralType).value };
  }
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return { kind: "literal", value: (type as ts.NumberLiteralType).value };
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return { kind: "literal", value: checker.typeToString(type) === "true" };
  }
  if (type.flags & ts.TypeFlags.StringLike) return { kind: "string" };
  if (type.flags & ts.TypeFlags.NumberLike) return { kind: "number" };
  if (type.flags & ts.TypeFlags.BooleanLike) return { kind: "boolean" };
  if (type.flags & ts.TypeFlags.Null) return { kind: "null" };
  if (type.flags & ts.TypeFlags.Undefined) return { kind: "undefined" };
  if (type.flags & ts.TypeFlags.Object) {
    if (checker.isArrayType(type)) {
      const typeArguments = checker.getTypeArguments(type as ts.TypeReference);
      const elementType = typeArguments[0];
      if (elementType === undefined) {
        throw new SemanticSourceError(
          "array element type could not be determined",
        );
      }
      return {
        kind: "array",
        elementType: buildTypeSchema(
          elementType,
          checker,
          location,
          depth + 1,
        ),
      };
    }
    return {
      kind: "object",
      properties: checker.getPropertiesOfType(type).map((property) => ({
        name: property.getName(),
        optional: Boolean(property.flags & ts.SymbolFlags.Optional),
        type: buildTypeSchema(
          checker.getTypeOfSymbolAtLocation(property, location),
          checker,
          location,
          depth + 1,
        ),
      })),
    };
  }
  throw new SemanticSourceError(
    `unsupported concept input type: ${checker.typeToString(type)}`,
  );
}
