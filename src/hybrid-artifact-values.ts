import { SEMANTIC_LIMITS } from "./semantic-limits";
import { sha256, stableJson } from "./stable-hash";

export type HybridArtifactErrorCode =
  | "INVALID_ARGUMENT"
  | "OUTPUT_EXISTS"
  | "INVALID_ARTIFACT"
  | "ARTIFACT_MISMATCH"
  | "SOURCE_CHANGED"
  | "TOOLCHAIN_MISMATCH"
  | "REBUILD_MISMATCH"
  | "PUBLICATION_FAILED";

export class HybridArtifactError extends Error {
  override name = "HybridArtifactError";

  constructor(
    public readonly code: HybridArtifactErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      `${code}: ${message}`.slice(0, SEMANTIC_LIMITS.diagnosticCharacters),
      options,
    );
  }
}

export function dataRecord(
  input: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalid(`${path} must be an object`);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    invalid(`${path} must not contain symbol fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const entries: [string, unknown][] = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.includes(key))
      invalid(`${path} contains unknown field ${key}`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      invalid(`${path}.${key} must be an enumerable data field`);
    }
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

export function exactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${path}.${key} is required`);
  }
}

export function boundedString(
  value: unknown,
  path: string,
  maximum = 4_096,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    invalid(`${path} must be a non-empty bounded string`);
  }
  return value;
}

export function identifier(value: unknown, path: string): string {
  const result = boundedString(value, path, 256);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(result)) {
    invalid(`${path} must be a TypeScript identifier`);
  }
  return result;
}

export function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    invalid(`${path} must be a SHA-256 hash`);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${stableJson(value)}\n`;
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function strictJsonValue(
  input: unknown,
  path = "value",
  seen = new Set<object>(),
): unknown {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean"
  ) {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) invalid(`${path} must be a finite number`);
    return input;
  }
  if (typeof input !== "object") invalid(`${path} must be JSON data`);
  if (seen.has(input)) invalid(`${path} must not contain a cycle`);
  seen.add(input);
  try {
    if (Object.getOwnPropertySymbols(input).length > 0) {
      invalid(`${path} must not contain symbol fields`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Array.isArray(input)) {
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        keys.length !== input.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        invalid(`${path} must be a dense array without extra fields`);
      }
      return keys.map((key) => {
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          invalid(`${path}[${key}] must be an enumerable data item`);
        }
        return strictJsonValue(descriptor.value, `${path}[${key}]`, seen);
      });
    }
    const entries = Object.entries(descriptors).map(([key, descriptor]) => {
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        invalid(`${path}.${key} must be an enumerable data field`);
      }
      return [
        key,
        strictJsonValue(descriptor.value, `${path}.${key}`, seen),
      ] as const;
    });
    return Object.fromEntries(entries);
  } finally {
    seen.delete(input);
  }
}

export function invalid(message: string, cause?: unknown): never {
  throw new HybridArtifactError("INVALID_ARTIFACT", message, { cause });
}
