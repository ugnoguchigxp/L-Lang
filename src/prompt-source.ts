import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { atomicWriteJson } from "./atomic-file";
import { readBounded } from "./wasm-artifact";
import {
  digest,
  encodeInput,
  parseContract,
  record,
  type WasmContract,
  WasmError,
} from "./wasm-contract";

export type Requirement = {
  id: string;
  level: "must" | "must-not" | "should";
  text: string;
};
export type PromptExample = {
  id: string;
  input: Record<string, unknown>;
  undefinedFields: string[];
  expected: boolean;
};
export type PromptSource = {
  version: 1;
  kind: "predicate";
  id: string;
  intent: string;
  requirements: Requirement[];
  unresolvedWhen: string[];
  profile: "predicate-i32-v1";
  contract: WasmContract;
  examples: PromptExample[];
};
export function fail(message: string): never {
  throw new WasmError("INVALID_PROMPT", message);
}
export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    fail(`invalid ${label}`);
  return value;
}
export function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 128) fail(`invalid ${label}`);
  return value;
}
export function identifier(value: unknown): string {
  const id = stringValue(value, "id");
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) fail("invalid id");
  return id;
}
export function unique(values: string[]): void {
  if (new Set(values).size !== values.length) fail("duplicate id");
}
export function parseRequirement(input: unknown): Requirement {
  const r = record(input, ["id", "level", "text"]);
  if (r.level !== "must" && r.level !== "must-not" && r.level !== "should")
    fail("invalid requirement level");
  return {
    id: identifier(r.id),
    level: r.level,
    text: stringValue(r.text, "requirement"),
  };
}
export function parseMeaning(input: unknown) {
  const s = record(input, ["intent", "requirements", "unresolvedWhen"]);
  const requirements = list(s.requirements, "requirements").map(
    parseRequirement,
  );
  if (!requirements.length) fail("at least one requirement is required");
  unique(requirements.map((r) => r.id));
  return {
    intent: stringValue(s.intent, "intent"),
    requirements,
    unresolvedWhen: list(s.unresolvedWhen, "unresolvedWhen").map((v) =>
      stringValue(v, "unresolvedWhen"),
    ),
  };
}
export function exampleInput(example: PromptExample): Record<string, unknown> {
  const input = { ...example.input };
  for (const key of example.undefinedFields) {
    if (Object.hasOwn(input, key)) fail("undefined field also has a value");
    Object.defineProperty(input, key, { value: undefined, enumerable: true });
  }
  return input;
}
export function parsePromptSource(input: unknown): PromptSource {
  const s = record(input, [
    "version",
    "kind",
    "id",
    "intent",
    "requirements",
    "unresolvedWhen",
    "profile",
    "contract",
    "examples",
  ]);
  if (
    s.version !== 1 ||
    s.kind !== "predicate" ||
    s.profile !== "predicate-i32-v1"
  )
    fail("unsupported source version/kind/profile");
  const meaning = parseMeaning({
    intent: s.intent,
    requirements: s.requirements,
    unresolvedWhen: s.unresolvedWhen,
  });
  const contract = parseContract(s.contract);
  const examples = list(s.examples, "examples").map((v): PromptExample => {
    const e = record(v, ["id", "input", "undefinedFields", "expected"]);
    if (typeof e.expected !== "boolean") fail("expected must be boolean");
    const input = record(
      e.input,
      contract.fields.map((f) => f.name),
    );
    for (const v of Object.values(input))
      if (v !== null && typeof v !== "boolean" && typeof v !== "string")
        fail("example values must be JSON scalar values");
    const example = {
      id: identifier(e.id),
      input,
      expected: e.expected,
      undefinedFields: list(e.undefinedFields, "undefinedFields").map((v) =>
        stringValue(v, "field"),
      ),
    };
    unique(example.undefinedFields);
    encodeInput(contract, exampleInput(example));
    return example;
  });
  unique(examples.map((e) => e.id));
  if (!examples.some((e) => e.expected) || !examples.some((e) => !e.expected))
    fail("provide independent positive and negative examples");
  const source: PromptSource = {
    version: 1,
    kind: "predicate",
    id: identifier(s.id),
    ...meaning,
    profile: "predicate-i32-v1",
    contract,
    examples,
  };
  if (Buffer.byteLength(JSON.stringify(source)) > 1024 * 1024)
    fail("source exceeds size limit");
  return source;
}
// Sort object keys only: requirement/example order remains part of the authored source.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined) fail("non-JSON value");
  return text;
}
export function contentHash(value: unknown): string {
  return digest(canonical(value));
}
export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBounded(path)));
}
export async function readPromptSource(path: string) {
  const source = parsePromptSource(await readJson(path));
  return { source, revision: contentHash(source) };
}
// All cooperating writers, including Lock publication, use the same canonical path.
export async function sourceTransaction<T>(
  path: string,
  action: (path: string) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const normalized = resolve(
    await realpath(dirname(resolve(path))),
    basename(path),
  );
  const mutex = `${normalized}.write-lock`;
  const handle = await open(mutex, "wx").catch(() => {
    throw new WasmError(
      "SOURCE_BUSY",
      "source is being written; stale write-lock requires manual recovery",
    );
  });
  try {
    for (const file of [normalized, `${normalized}.lock.json`]) {
      const info = await lstat(file).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (info?.isSymbolicLink())
        fail("source and lock must not be symbolic links");
    }
    return await action(normalized);
  } finally {
    await handle.close();
    await unlink(mutex);
  }
}
export async function createPromptSource(path: string, input: unknown) {
  const source = parsePromptSource(input);
  return sourceTransaction(path, async (file) => {
    // Publish a complete file exclusively; an existing source is never replaced.
    const temporary = `${file}.${randomUUID()}.create.tmp`;
    await atomicWriteJson(temporary, source);
    try {
      await link(temporary, file);
    } finally {
      await unlink(temporary);
    }
    return { source, revision: contentHash(source) };
  });
}
export type RequirementPatch = { id: string; replacement: Requirement | null };
export function parsePatches(input: unknown): RequirementPatch[] {
  const p = record(input, ["changes"]);
  const changes = list(p.changes, "changes").map((v) => {
    const c = record(v, ["id", "replacement"]);
    const id = identifier(c.id);
    const replacement =
      c.replacement === null ? null : parseRequirement(c.replacement);
    if (replacement && replacement.id !== id) fail("replacement id differs");
    return { id, replacement };
  });
  if (!changes.length) fail("empty patch");
  unique(changes.map((c) => c.id));
  return changes;
}
export async function updatePromptSource(
  path: string,
  expectedRevision: string,
  allowedIds: string[],
  patch: unknown,
) {
  const changes = parsePatches(patch);
  if (changes.some((c) => !allowedIds.includes(c.id)))
    fail("patch exceeds allowed requirement IDs");
  return sourceTransaction(path, async (file) => {
    const current = await readPromptSource(file);
    if (current.revision !== expectedRevision)
      throw new WasmError("SOURCE_CONFLICT", "source revision changed");
    let requirements = current.source.requirements;
    for (const c of changes) {
      const exists = requirements.some((r) => r.id === c.id);
      if (!c.replacement && !exists) fail("cannot remove missing requirement");
      const replacement = c.replacement;
      requirements = replacement
        ? exists
          ? requirements.map((r) => (r.id === c.id ? replacement : r))
          : [...requirements, replacement]
        : requirements.filter((r) => r.id !== c.id);
    }
    const source = parsePromptSource({ ...current.source, requirements });
    await atomicWriteJson(file, source);
    return { source, revision: contentHash(source) };
  });
}
