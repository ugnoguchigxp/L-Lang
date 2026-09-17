import ts from "typescript";

import {
  canonicalHash,
  dataRecord,
  exactKeys,
  invalid,
} from "./hybrid-artifact-values";

export const HYBRID_TYPESCRIPT_PROFILE = "restricted-predicate-ts-v1" as const;

export type HybridTypeScriptProfile = {
  version: 1;
  profile: typeof HYBRID_TYPESCRIPT_PROFILE;
  typescriptVersion: string;
  compilerOptions: {
    strictNullChecks: true;
    exactOptionalPropertyTypes: true;
    noUncheckedIndexedAccess: true;
    target: "ES2022";
    module: "ESNext";
    moduleDetection: "force";
    useDefineForClassFields: true;
    skipLibCheck: true;
  };
};

export function createHybridTypeScriptProfile(): HybridTypeScriptProfile {
  return {
    version: 1,
    profile: HYBRID_TYPESCRIPT_PROFILE,
    typescriptVersion: ts.version,
    compilerOptions: {
      strictNullChecks: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      target: "ES2022",
      module: "ESNext",
      moduleDetection: "force",
      useDefineForClassFields: true,
      skipLibCheck: true,
    },
  };
}

export function parseHybridTypeScriptProfile(
  input: unknown,
): HybridTypeScriptProfile {
  const root = dataRecord(input, "typescriptProfile", [
    "version",
    "profile",
    "typescriptVersion",
    "compilerOptions",
  ]);
  exactKeys(root, "typescriptProfile", [
    "version",
    "profile",
    "typescriptVersion",
    "compilerOptions",
  ]);
  const options = dataRecord(
    root.compilerOptions,
    "typescriptProfile.compilerOptions",
    [
      "strictNullChecks",
      "exactOptionalPropertyTypes",
      "noUncheckedIndexedAccess",
      "target",
      "module",
      "moduleDetection",
      "useDefineForClassFields",
      "skipLibCheck",
    ],
  );
  exactKeys(options, "typescriptProfile.compilerOptions", [
    "strictNullChecks",
    "exactOptionalPropertyTypes",
    "noUncheckedIndexedAccess",
    "target",
    "module",
    "moduleDetection",
    "useDefineForClassFields",
    "skipLibCheck",
  ]);
  const expected = createHybridTypeScriptProfile();
  if (
    root.version !== expected.version ||
    root.profile !== expected.profile ||
    typeof root.typescriptVersion !== "string" ||
    root.typescriptVersion.length === 0 ||
    root.typescriptVersion.length > 64 ||
    options.strictNullChecks !== true ||
    options.exactOptionalPropertyTypes !== true ||
    options.noUncheckedIndexedAccess !== true ||
    options.target !== "ES2022" ||
    options.module !== "ESNext" ||
    options.moduleDetection !== "force" ||
    options.useDefineForClassFields !== true ||
    options.skipLibCheck !== true
  ) {
    invalid("unsupported TypeScript artifact profile");
  }
  return {
    ...expected,
    typescriptVersion: root.typescriptVersion,
  };
}

export function hybridTypeScriptProfileHash(input: unknown): string {
  return canonicalHash(parseHybridTypeScriptProfile(input));
}

export function hybridTypeScriptConfig(profileInput: unknown): object {
  const profile = parseHybridTypeScriptProfile(profileInput);
  return {
    compilerOptions: {
      ...profile.compilerOptions,
      moduleResolution: "Bundler",
      noEmit: true,
      types: [],
    },
    include: ["source.ts"],
  };
}
