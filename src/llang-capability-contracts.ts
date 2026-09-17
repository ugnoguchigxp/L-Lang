import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  parseLlangBuildManifest,
  validateLlangArtifact,
} from "./llang-artifact";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { checkLlangProgram } from "./llang-program";
import {
  contentHash,
  identifier,
  list,
  parseRequirement,
  stringValue,
  unique,
} from "./prompt-source";
import { resolveContainedFile } from "./contained-path";
import {
  digest,
  encodeInput,
  parseContract,
  record,
  type WasmContract,
  WasmError,
} from "./wasm-contract";

export const LLANG_CAPABILITY_VERIFIER = "llang-capability-v2";
export const roles = ["request", "source", "build", "wasm", "tests"] as const;
export type Role = (typeof roles)[number];
export type FileRef = { path: string; hash: string };

function assertUnicodeScalars(value: unknown, label: string): void {
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === "string") {
      for (let index = 0; index < next.length; index++) {
        const unit = next.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const following = next.charCodeAt(index + 1);
          if (!(following >= 0xdc00 && following <= 0xdfff))
            throw new WasmError(
              "INVALID_CAPABILITY",
              `${label} contains an unpaired Unicode surrogate`,
            );
          index++;
        } else if (unit >= 0xdc00 && unit <= 0xdfff)
          throw new WasmError(
            "INVALID_CAPABILITY",
            `${label} contains an unpaired Unicode surrogate`,
          );
      }
    } else if (Array.isArray(next)) pending.push(...next);
    else if (next && typeof next === "object")
      pending.push(...Object.keys(next), ...Object.values(next));
  }
}

export type LlangRequest = {
  version: 2;
  id: string;
  body: string;
  profile: "predicate-i32-v1";
  contract: WasmContract;
  requirements: {
    id: string;
    level: "must" | "must-not" | "should";
    text: string;
  }[];
};

export function parseLlangRequest(input: unknown): LlangRequest {
  const value = record(input, [
    "version",
    "id",
    "body",
    "profile",
    "contract",
    "requirements",
  ]);
  if (value.version !== 2 || value.profile !== "predicate-i32-v1")
    throw new WasmError(
      "INVALID_CAPABILITY",
      "unsupported request version/profile",
    );
  const requirements = list(value.requirements, "requirements").map(
    parseRequirement,
  );
  unique(requirements.map((item) => item.id));
  const request: LlangRequest = {
    version: 2,
    id: identifier(value.id),
    body: stringValue(value.body, "request body"),
    profile: "predicate-i32-v1",
    contract: parseContract(value.contract),
    requirements,
  };
  assertUnicodeScalars(request, "request");
  if (Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024)
    throw new WasmError("INVALID_CAPABILITY", "request exceeds size limit");
  return request;
}

export function requestRevision(request: LlangRequest) {
  return contentHash(request);
}

export type LlangCase = {
  id: string;
  requirementIds: string[];
  input: Record<string, unknown>;
  undefinedFields: string[];
  expected:
    | { kind: "value"; value: boolean }
    | { kind: "error"; code: "INVALID_INPUT" };
};
export type LlangSuite = {
  version: 2;
  requestRevision: string;
  contractHash: string;
  cases: LlangCase[];
};

export function requirementCoverage(request: LlangRequest, suite: LlangSuite) {
  const requirements = request.requirements.map((requirement) => ({
    id: requirement.id,
    level: requirement.level,
    caseIds: suite.cases
      .filter((item) => item.requirementIds.includes(requirement.id))
      .map((item) => item.id),
  }));
  return {
    coverage: request.requirements.length
      ? ("evaluated" as const)
      : ("not-evaluated" as const),
    requirements,
    uncoveredRequirements: requirements
      .filter(
        (requirement) =>
          requirement.level !== "should" && !requirement.caseIds.length,
      )
      .map((requirement) => requirement.id),
  };
}

export function caseInput(value: Pick<LlangCase, "input" | "undefinedFields">) {
  const input = { ...value.input };
  for (const key of value.undefinedFields) {
    if (Object.hasOwn(input, key))
      throw new WasmError(
        "INVALID_CAPABILITY",
        "undefined field also has a value",
      );
    Object.defineProperty(input, key, { value: undefined, enumerable: true });
  }
  return input;
}

function parseCaseData(
  input: unknown,
  contract: WasmContract,
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Object.getOwnPropertySymbols(input).length
  )
    throw new WasmError("INVALID_CAPABILITY", "test input must be JSON data");
  const known = new Set(contract.fields.map((field) => field.name));
  const entries = Object.entries(Object.getOwnPropertyDescriptors(input));
  if (
    entries.some(
      ([key, descriptor]) =>
        !known.has(key) ||
        !("value" in descriptor) ||
        descriptor.value === undefined ||
        (descriptor.value !== null &&
          typeof descriptor.value !== "boolean" &&
          typeof descriptor.value !== "string"),
    )
  )
    throw new WasmError(
      "INVALID_CAPABILITY",
      "test input must use known JSON scalar fields; use undefinedFields for undefined",
    );
  return Object.fromEntries(
    entries.map(([key, descriptor]) => [
      key,
      (descriptor as PropertyDescriptor & { value: unknown }).value,
    ]),
  );
}

export function parseLlangSuite(
  input: unknown,
  request: LlangRequest,
): LlangSuite {
  const value = record(input, [
    "version",
    "requestRevision",
    "contractHash",
    "cases",
  ]);
  if (
    value.version !== 2 ||
    value.requestRevision !== requestRevision(request) ||
    value.contractHash !== contentHash(request.contract)
  )
    throw new WasmError(
      "INVALID_CAPABILITY",
      "suite request or contract mismatch",
    );
  const known = new Set(request.requirements.map((item) => item.id));
  const cases = list(value.cases, "cases").map((raw): LlangCase => {
    const item = record(raw, [
      "id",
      "requirementIds",
      "input",
      "undefinedFields",
      "expected",
    ]);
    const requirementIds = list(item.requirementIds, "requirementIds").map(
      identifier,
    );
    unique(requirementIds);
    if (requirementIds.some((id) => !known.has(id)))
      throw new WasmError("INVALID_CAPABILITY", "unknown requirement id");
    const input = parseCaseData(item.input, request.contract);
    const undefinedFields = list(item.undefinedFields, "undefinedFields").map(
      (field) => stringValue(field, "undefined field"),
    );
    unique(undefinedFields);
    const contractFields = new Set(
      request.contract.fields.map((field) => field.name),
    );
    if (undefinedFields.some((field) => !contractFields.has(field)))
      throw new WasmError("INVALID_CAPABILITY", "unknown undefined field");
    const expectation = record(item.expected, ["kind", "value", "code"]);
    let expected: LlangCase["expected"];
    if (
      expectation.kind === "value" &&
      typeof expectation.value === "boolean" &&
      !Object.hasOwn(expectation, "code")
    )
      expected = { kind: "value", value: expectation.value };
    else if (
      expectation.kind === "error" &&
      expectation.code === "INVALID_INPUT" &&
      !Object.hasOwn(expectation, "value")
    )
      expected = { kind: "error", code: "INVALID_INPUT" };
    else
      throw new WasmError("INVALID_CAPABILITY", "unsupported test expectation");
    const result = {
      id: identifier(item.id),
      requirementIds,
      input,
      undefinedFields,
      expected,
    };
    const materialized = caseInput(result);
    if (expected.kind === "value") encodeInput(request.contract, materialized);
    else {
      try {
        encodeInput(request.contract, materialized);
        throw new WasmError(
          "INVALID_CAPABILITY",
          "error expectation requires invalid input",
        );
      } catch (error) {
        if (!(error instanceof WasmError) || error.code !== "INVALID_INPUT")
          throw error;
      }
    }
    return result;
  });
  unique(cases.map((item) => item.id));
  if (
    !cases.some(
      (item) => item.expected.kind === "value" && item.expected.value,
    ) ||
    !cases.some(
      (item) => item.expected.kind === "value" && !item.expected.value,
    )
  )
    throw new WasmError(
      "INVALID_CAPABILITY",
      "suite needs positive and negative cases",
    );
  const suite: LlangSuite = {
    version: 2,
    requestRevision: String(value.requestRevision),
    contractHash: String(value.contractHash),
    cases,
  };
  assertUnicodeScalars(suite, "suite");
  if (Buffer.byteLength(JSON.stringify(suite)) > 1024 * 1024)
    throw new WasmError("INVALID_CAPABILITY", "suite exceeds size limit");
  return suite;
}

export type LlangCapabilityManifest = {
  version: 2;
  metadata: {
    id: string;
    release: string;
    purpose: string;
    useWhen: string;
    doNotUseWhen: string;
  };
  profile: "predicate-i32-v1";
  output: "boolean";
  permissions: [];
  files: Record<Role, FileRef>;
};

export function parseLlangCapabilityMetadata(
  input: unknown,
): LlangCapabilityManifest["metadata"] {
  const value = record(input, [
    "id",
    "release",
    "purpose",
    "useWhen",
    "doNotUseWhen",
  ]);
  const metadata = {
    id: identifier(value.id),
    release: identifier(value.release),
    purpose: stringValue(value.purpose, "purpose"),
    useWhen: stringValue(value.useWhen, "useWhen"),
    doNotUseWhen: stringValue(value.doNotUseWhen, "doNotUseWhen"),
  };
  assertUnicodeScalars(metadata, "metadata");
  return metadata;
}

export function parseLlangCapabilityManifest(
  input: unknown,
): LlangCapabilityManifest {
  const value = record(input, [
    "version",
    "metadata",
    "profile",
    "output",
    "permissions",
    "files",
  ]);
  if (
    value.version !== 2 ||
    value.profile !== "predicate-i32-v1" ||
    value.output !== "boolean" ||
    !Array.isArray(value.permissions) ||
    value.permissions.length
  )
    throw new WasmError(
      "INVALID_CAPABILITY",
      "unsupported capability contract",
    );
  const rawFiles = record(value.files, [...roles]);
  const files = {} as Record<Role, FileRef>;
  for (const role of roles) {
    const ref = record(rawFiles[role], ["path", "hash"]);
    if (
      typeof ref.path !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref.path) ||
      ref.path === "capability.json"
    )
      throw new WasmError("INVALID_CAPABILITY", "invalid package path");
    if (typeof ref.hash !== "string" || !/^[a-f0-9]{64}$/.test(ref.hash))
      throw new WasmError("INVALID_CAPABILITY", "invalid file hash");
    files[role] = { path: ref.path, hash: ref.hash };
  }
  if (new Set(roles.map((role) => files[role].path)).size !== roles.length)
    throw new WasmError("INVALID_CAPABILITY", "duplicate package path");
  return {
    version: 2,
    metadata: parseLlangCapabilityMetadata(value.metadata),
    profile: "predicate-i32-v1",
    output: "boolean",
    permissions: [],
    files,
  };
}

export async function regularBytes(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new WasmError(
      "INVALID_CAPABILITY",
      "expected regular non-symlink file",
    );
  if (info.size > 1024 * 1024)
    throw new WasmError(
      "INVALID_CAPABILITY",
      "capability file exceeds size limit",
    );
  const bytes = await readFile(path);
  if (bytes.byteLength > 1024 * 1024)
    throw new WasmError(
      "INVALID_CAPABILITY",
      "capability file exceeds size limit",
    );
  return bytes;
}
export function json(bytes: Uint8Array, path: string) {
  return parseStrictJsonObject(decodeUtf8(bytes, path), path);
}

export async function readLlangCapability(path: string) {
  const absolute = resolve(path);
  const manifestBytes = await regularBytes(absolute);
  const manifest = parseLlangCapabilityManifest(json(manifestBytes, absolute));
  const root = dirname(absolute);
  const files = {} as Record<Role, Uint8Array>;
  for (const role of roles) {
    const file = await resolveContainedFile(
      root,
      manifest.files[role].path,
      role,
      { rejectSymbolicLinks: true },
    );
    files[role] = await regularBytes(file);
    if (digest(files[role]) !== manifest.files[role].hash)
      throw new WasmError("INVALID_CAPABILITY", `${role} hash mismatch`);
  }
  const request = parseLlangRequest(
    json(files.request, manifest.files.request.path),
  );
  const sourceText = decodeUtf8(files.source, manifest.files.source.path);
  const checked = checkLlangProgram(
    sourceText,
    manifest.files.source.path,
  ).checked;
  if (!checked)
    throw new WasmError("INVALID_CAPABILITY", "invalid packaged L-Lang source");
  const build = parseLlangBuildManifest(
    json(files.build, manifest.files.build.path),
  );
  const suite = parseLlangSuite(
    json(files.tests, manifest.files.tests.path),
    request,
  );
  if (
    manifest.metadata.id !== request.id ||
    checked.program.id !== request.id ||
    contentHash(checked.program.contract) !== contentHash(request.contract) ||
    build.sourceHash !== checked.sourceHash ||
    build.programHash !== checked.programHash ||
    contentHash(build.contract) !== contentHash(request.contract) ||
    build.file !== manifest.files.wasm.path ||
    build.wasmHash !== digest(files.wasm)
  )
    throw new WasmError(
      "INVALID_CAPABILITY",
      "request/source/build linkage mismatch",
    );
  if (digest(await regularBytes(absolute)) !== digest(manifestBytes))
    throw new WasmError("INVALID_CAPABILITY", "manifest changed while reading");
  validateLlangArtifact(build, files.wasm);
  return {
    manifest,
    packageHash: contentHash(manifest),
    request,
    sourceText,
    checked,
    build,
    suite,
    bytes: files.wasm,
  };
}
