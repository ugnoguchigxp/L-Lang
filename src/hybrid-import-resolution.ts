import {
  canonicalTypeHash,
  parseCanonicalPredicateType,
  type CanonicalPredicateType,
} from "./canonical-type-ir";
import {
  boundedString,
  canonicalHash,
  dataRecord,
  exactKeys,
  hash,
  identifier,
  invalid,
  strictJsonValue,
} from "./hybrid-artifact-values";
import {
  hybridTypeScriptProfileHash,
  parseHybridTypeScriptProfile,
} from "./hybrid-typescript-profile";
import { parsePredicateExpression, type PredicateExpression } from "./ir";
import { fingerprintFor } from "./stable-hash";
import { contractFromCanonicalType, lowerPredicate } from "./wasm-core";

export type HybridImportResolution = {
  version: 1;
  profile: "predicate-i32-v1";
  source: {
    file: "source.ts";
    functionName: string;
    sourceHash: string;
  };
  typescript: {
    profile: "restricted-predicate-ts-v1";
    version: string;
    optionsHash: string;
  };
  input: {
    parameterName: string;
    typeName: string;
    canonicalType: CanonicalPredicateType;
    canonicalTypeHash: string;
  };
  body: PredicateExpression;
  semanticHash: string;
};

export function parseHybridImportResolution(
  input: unknown,
  typescriptProfileInput?: unknown,
): HybridImportResolution {
  const root = dataRecord(input, "resolution", [
    "version",
    "profile",
    "source",
    "typescript",
    "input",
    "body",
    "semanticHash",
  ]);
  exactKeys(root, "resolution", [
    "version",
    "profile",
    "source",
    "typescript",
    "input",
    "body",
    "semanticHash",
  ]);
  const source = dataRecord(root.source, "resolution.source", [
    "file",
    "functionName",
    "sourceHash",
  ]);
  exactKeys(source, "resolution.source", [
    "file",
    "functionName",
    "sourceHash",
  ]);
  const typescript = dataRecord(root.typescript, "resolution.typescript", [
    "profile",
    "version",
    "optionsHash",
  ]);
  exactKeys(typescript, "resolution.typescript", [
    "profile",
    "version",
    "optionsHash",
  ]);
  const value = dataRecord(root.input, "resolution.input", [
    "parameterName",
    "typeName",
    "canonicalType",
    "canonicalTypeHash",
  ]);
  exactKeys(value, "resolution.input", [
    "parameterName",
    "typeName",
    "canonicalType",
    "canonicalTypeHash",
  ]);
  if (root.version !== 1 || root.profile !== "predicate-i32-v1") {
    invalid("unsupported hybrid import resolution");
  }
  if (source.file !== "source.ts")
    invalid("resolution source file must be source.ts");
  const canonicalType = parseCanonicalPredicateType(value.canonicalType);
  const body = parsePredicateExpression(
    strictJsonValue(root.body, "resolution.body"),
  );
  const contract = contractFromCanonicalType(canonicalType);
  lowerPredicate(body, contract);
  const expectedTypeHash = canonicalTypeHash(canonicalType);
  const expectedSemanticHash = fingerprintFor({
    profile: "predicate-i32-v1",
    contract,
    body,
  });
  if (
    hash(value.canonicalTypeHash, "resolution.input.canonicalTypeHash") !==
    expectedTypeHash
  ) {
    invalid("canonical type hash mismatch");
  }
  if (
    hash(root.semanticHash, "resolution.semanticHash") !== expectedSemanticHash
  ) {
    invalid("semantic hash mismatch");
  }
  const profileName = boundedString(
    typescript.profile,
    "resolution.typescript.profile",
    64,
  );
  if (profileName !== "restricted-predicate-ts-v1")
    invalid("unsupported TypeScript profile");
  const version = boundedString(
    typescript.version,
    "resolution.typescript.version",
    64,
  );
  const optionsHash = hash(
    typescript.optionsHash,
    "resolution.typescript.optionsHash",
  );
  if (typescriptProfileInput !== undefined) {
    const profile = parseHybridTypeScriptProfile(typescriptProfileInput);
    if (
      profile.typescriptVersion !== version ||
      hybridTypeScriptProfileHash(profile) !== optionsHash
    ) {
      invalid("TypeScript profile linkage mismatch");
    }
  }
  return {
    version: 1,
    profile: "predicate-i32-v1",
    source: {
      file: "source.ts",
      functionName: identifier(
        source.functionName,
        "resolution.source.functionName",
      ),
      sourceHash: hash(source.sourceHash, "resolution.source.sourceHash"),
    },
    typescript: {
      profile: "restricted-predicate-ts-v1",
      version,
      optionsHash,
    },
    input: {
      parameterName: identifier(
        value.parameterName,
        "resolution.input.parameterName",
      ),
      typeName: identifier(value.typeName, "resolution.input.typeName"),
      canonicalType,
      canonicalTypeHash: expectedTypeHash,
    },
    body,
    semanticHash: expectedSemanticHash,
  };
}

export function hybridImportResolutionHash(input: unknown): string {
  return canonicalHash(parseHybridImportResolution(input));
}
