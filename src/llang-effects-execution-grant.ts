import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isIP } from "node:net";
import {
  DEFAULT_EFFECTS_LIMITS,
  type BudgetLimits,
  type EffectsGrant,
  type EffectsManifest,
} from "./llang-effects-contract";
import {
  decodeUtf8,
  LLANG_SOURCE_BYTES,
  parseStrictJsonObject,
} from "./llang-jsonc";
import { fingerprintFor } from "./stable-hash";
import { digest } from "./wasm-contract";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";

const HASH = /^[0-9a-f]{64}$/;
const HEADER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const LIMIT_NAMES = Object.keys(
  DEFAULT_EFFECTS_LIMITS,
) as (keyof BudgetLimits)[];

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const sortedUnique = (values: readonly string[]) =>
  values.length === new Set(values).size &&
  values.join("\0") === [...values].sort().join("\0");

export type EffectsExecutionGrantDocument = Readonly<{
  format: "llang-effects-grant";
  version: 1;
  bundleIdentityHash: string;
  operations: readonly string[];
  file: null | Readonly<{
    adapterRoot: string;
    logicalRoots: readonly string[];
    read: boolean;
    write: boolean;
    replace: boolean;
  }>;
  http: null | Readonly<{
    origins: readonly string[];
    methods: readonly string[];
    requestHeaders: readonly string[];
    allowPublic: boolean;
    allowedAddresses: readonly string[];
  }>;
  wallClock: boolean;
  deadlineMs: number;
  limits: Readonly<Partial<BudgetLimits>>;
}>;

export type ParsedEffectsExecutionGrant = Readonly<{
  path: string;
  fileIdentity: Readonly<{ dev: number; ino: number }>;
  sourceHash: string;
  commitmentHash: string;
  document: EffectsExecutionGrantDocument;
  grant: EffectsGrant;
  limits: BudgetLimits;
  adapterRoot?: string;
  summary: Readonly<Record<string, unknown>>;
}>;

function logicalRoot(value: string): boolean {
  if (!value || isAbsolute(value) || value.includes("\\")) return false;
  const normalized = value.split("/");
  return normalized.every((part) => part && part !== "." && part !== "..");
}

function networkEntry(value: string): boolean {
  const slash = value.lastIndexOf("/"),
    address = slash < 0 ? value : value.slice(0, slash),
    family = isIP(address);
  if (!family) return false;
  if (slash < 0) return true;
  const prefix = Number(value.slice(slash + 1));
  return (
    Number.isInteger(prefix) &&
    prefix >= 0 &&
    prefix <= (family === 4 ? 32 : 128)
  );
}

function parseLimits(value: unknown): Readonly<Partial<BudgetLimits>> {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !LIMIT_NAMES.includes(key as keyof BudgetLimits),
    )
  )
    throw new Error("INVALID_EFFECTS_GRANT_LIMITS");
  const result: Partial<Record<keyof BudgetLimits, number>> = {};
  for (const [name, raw] of Object.entries(value)) {
    const key = name as keyof BudgetLimits;
    if (
      !Number.isSafeInteger(raw) ||
      Number(raw) < 0 ||
      Number(raw) > DEFAULT_EFFECTS_LIMITS[key]
    )
      throw new Error(`INVALID_EFFECTS_GRANT_LIMIT: ${name}`);
    result[key] = Number(raw);
  }
  return Object.freeze(result);
}

export function parseEffectsExecutionGrant(
  value: unknown,
): EffectsExecutionGrantDocument {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "bundleIdentityHash",
      "operations",
      "file",
      "http",
      "wallClock",
      "deadlineMs",
      "limits",
    ]) ||
    value.format !== "llang-effects-grant" ||
    value.version !== 1 ||
    !HASH.test(String(value.bundleIdentityHash)) ||
    !Array.isArray(value.operations) ||
    !value.operations.every(
      (item) =>
        typeof item === "string" &&
        /^[a-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)*@[1-9][0-9]*$/.test(item),
    ) ||
    !sortedUnique(value.operations as string[]) ||
    typeof value.wallClock !== "boolean" ||
    !Number.isSafeInteger(value.deadlineMs) ||
    Number(value.deadlineMs) < 1 ||
    Number(value.deadlineMs) > 86_400_000
  )
    throw new Error("INVALID_EFFECTS_GRANT");

  if (value.file !== null) {
    if (
      !object(value.file) ||
      !exact(value.file, [
        "adapterRoot",
        "logicalRoots",
        "read",
        "write",
        "replace",
      ]) ||
      typeof value.file.adapterRoot !== "string" ||
      !value.file.adapterRoot ||
      !Array.isArray(value.file.logicalRoots) ||
      !value.file.logicalRoots.every(
        (item) => typeof item === "string" && logicalRoot(item),
      ) ||
      !sortedUnique(value.file.logicalRoots as string[]) ||
      typeof value.file.read !== "boolean" ||
      typeof value.file.write !== "boolean" ||
      typeof value.file.replace !== "boolean" ||
      (value.file.replace && !value.file.write)
    )
      throw new Error("INVALID_EFFECTS_FILE_GRANT");
  }

  if (value.http !== null) {
    if (
      !object(value.http) ||
      !exact(value.http, [
        "origins",
        "methods",
        "requestHeaders",
        "allowPublic",
        "allowedAddresses",
      ]) ||
      !Array.isArray(value.http.origins) ||
      !value.http.origins.every((item) => {
        if (typeof item !== "string") return false;
        try {
          const url = new URL(item);
          return (
            url.origin === item &&
            !url.username &&
            !url.password &&
            ["http:", "https:"].includes(url.protocol)
          );
        } catch {
          return false;
        }
      }) ||
      !sortedUnique(value.http.origins as string[]) ||
      !Array.isArray(value.http.methods) ||
      !value.http.methods.every(
        (item) => typeof item === "string" && METHODS.has(item),
      ) ||
      !sortedUnique(value.http.methods as string[]) ||
      !Array.isArray(value.http.requestHeaders) ||
      !value.http.requestHeaders.every(
        (item) =>
          typeof item === "string" &&
          item === item.toLowerCase() &&
          HEADER.test(item),
      ) ||
      !sortedUnique(value.http.requestHeaders as string[]) ||
      typeof value.http.allowPublic !== "boolean" ||
      !Array.isArray(value.http.allowedAddresses) ||
      !value.http.allowedAddresses.every(
        (item) => typeof item === "string" && networkEntry(item),
      ) ||
      !sortedUnique(value.http.allowedAddresses as string[])
    )
      throw new Error("INVALID_EFFECTS_HTTP_GRANT");
  }

  const limits = parseLimits(value.limits);
  return Object.freeze({
    ...(value as unknown as EffectsExecutionGrantDocument),
    operations: Object.freeze([...(value.operations as string[])]),
    limits,
  });
}

export async function readEffectsExecutionGrant(
  path: string,
  expectedBundleIdentityHash: string,
  manifest: EffectsManifest,
): Promise<ParsedEffectsExecutionGrant> {
  const absolute = resolve(path),
    snapshot = await readStableRegularFileSnapshot(
      absolute,
      LLANG_SOURCE_BYTES,
      "INVALID_EFFECTS_GRANT_FILE",
    ),
    bytes = snapshot.bytes;
  const document = parseEffectsExecutionGrant(
    parseStrictJsonObject(decodeUtf8(bytes, absolute), absolute),
  );
  if (document.bundleIdentityHash !== expectedBundleIdentityHash)
    throw new Error("EFFECTS_GRANT_BUNDLE_MISMATCH");
  const required = manifest.operations.map(
    (item) => `${item.id}@${item.version}`,
  );
  if (
    required.some((item) => !document.operations.includes(item)) ||
    document.operations.some((item) => !required.includes(item))
  )
    throw new Error("EFFECTS_GRANT_OPERATION_MISMATCH");

  let adapterRoot: string | undefined;
  if (document.file) {
    const candidate = resolve(dirname(absolute), document.file.adapterRoot);
    if ((await lstat(candidate)).isSymbolicLink())
      throw new Error("INVALID_FILE_ROOT");
    adapterRoot = await realpath(candidate);
    if (!(await lstat(adapterRoot)).isDirectory())
      throw new Error("INVALID_FILE_ROOT");
  }
  const limits = Object.freeze({
    ...DEFAULT_EFFECTS_LIMITS,
    ...document.limits,
  });
  const grant: EffectsGrant = Object.freeze({
    operations: new Set(document.operations),
    ...(document.file
      ? {
          file: Object.freeze({
            roots: document.file.logicalRoots,
            read: document.file.read,
            write: document.file.write,
            replace: document.file.replace,
          }),
        }
      : {}),
    ...(document.http
      ? {
          http: Object.freeze({
            origins: new Set(document.http.origins),
            methods: new Set(document.http.methods),
            requestHeaders: new Set(document.http.requestHeaders),
          }),
        }
      : {}),
    wallClock: document.wallClock,
  });
  return Object.freeze({
    path: absolute,
    fileIdentity: Object.freeze({ dev: snapshot.dev, ino: snapshot.ino }),
    sourceHash: digest(bytes),
    commitmentHash: fingerprintFor(document),
    document,
    grant,
    limits,
    ...(adapterRoot ? { adapterRoot } : {}),
    summary: Object.freeze({
      operations: document.operations,
      file: document.file
        ? {
            logicalRoots: document.file.logicalRoots,
            read: document.file.read,
            write: document.file.write,
            replace: document.file.replace,
          }
        : null,
      http: document.http
        ? {
            origins: document.http.origins,
            methods: document.http.methods,
            requestHeaders: document.http.requestHeaders,
            allowPublic: document.http.allowPublic,
            allowedAddresses: document.http.allowedAddresses,
          }
        : null,
      wallClock: document.wallClock,
      deadlineMs: document.deadlineMs,
      limits,
    }),
  });
}

export function pathsOverlap(left: string, right: string): boolean {
  const within = (root: string, candidate: string) => {
    const relation = relative(root, candidate);
    return (
      relation === "" ||
      (!relation.startsWith(`..${sep}`) &&
        relation !== ".." &&
        !isAbsolute(relation))
    );
  };
  return within(left, right) || within(right, left);
}
