export function extensionRecord(
  input: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

export function extensionKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key))
      throw new Error(`${path} contains unknown field ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${path} is missing ${key}`);
  }
}

export function extensionInteger(
  input: unknown,
  min: number,
  max: number,
  path: string,
): number {
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < min ||
    (input as number) > max
  ) {
    throw new Error(`${path} must be an integer between ${min} and ${max}`);
  }
  return input as number;
}

export function extensionNumber(
  input: unknown,
  min: number,
  max: number,
  path: string,
): number {
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < min ||
    input > max
  ) {
    throw new Error(`${path} must be a number between ${min} and ${max}`);
  }
  return input;
}

export function extensionHash(input: unknown, path: string): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/.test(input))
    throw new Error(`${path} must be a SHA-256 hash`);
  return input;
}
