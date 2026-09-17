import { readFile } from "node:fs/promises";

export const SEMANTIC_LIMITS = {
  predicateExpressionNodes: 256,
  predicateExpressionDepth: 32,
  predicateConditions: 64,
  propertyPathSegments: 8,
  propertySegmentCharacters: 128,
  diagnostics: 32,
  diagnosticCharacters: 2_000,
  typescriptSourceBytes: 2 * 1024 * 1024,
  externalJsonBytes: 2 * 1024 * 1024,
  lockBytes: 16 * 1024 * 1024,
  responseItems: 64,
  responseContentItems: 64,
} as const;

export function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new Error(`${path} contains unknown field ${unknown}`);
  }
}

export function parseBoundedJsonText(
  text: string,
  path: string,
  maximumBytes = SEMANTIC_LIMITS.externalJsonBytes,
): unknown {
  assertTextByteLength(text, maximumBytes, path);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${path} must contain valid JSON`);
  }
}

export async function readBoundedJsonFile(
  path: string,
  label: string,
  maximumBytes = SEMANTIC_LIMITS.externalJsonBytes,
): Promise<unknown> {
  const data = await readFile(path);
  if (data.byteLength > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  return parseBoundedJsonText(data.toString("utf8"), label, maximumBytes);
}

export async function readBoundedResponseText(
  response: Response,
  label: string,
  maximumBytes = SEMANTIC_LIMITS.externalJsonBytes,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maximumBytes
  ) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds ${maximumBytes} bytes`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export function validateDiagnostics(input: unknown, path: string): string[] {
  if (
    !Array.isArray(input) ||
    !input.every((item) => typeof item === "string")
  ) {
    throw new Error(`${path} must be an array of strings`);
  }
  if (input.length > SEMANTIC_LIMITS.diagnostics) {
    throw new Error(
      `${path} must contain at most ${SEMANTIC_LIMITS.diagnostics} items`,
    );
  }
  input.forEach((diagnostic, index) => {
    if (diagnostic.length > SEMANTIC_LIMITS.diagnosticCharacters) {
      throw new Error(
        `${path}[${index}] must contain at most ${SEMANTIC_LIMITS.diagnosticCharacters} characters`,
      );
    }
  });
  return input;
}

export function assertTextByteLength(
  text: string,
  maximumBytes: number,
  path: string,
): void {
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new Error(`${path} exceeds ${maximumBytes} bytes`);
  }
}
