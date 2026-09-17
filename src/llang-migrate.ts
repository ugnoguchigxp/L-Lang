import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseResolutionLock } from "./prompt-resolution";
import { contentHash, parsePromptSource } from "./prompt-source";
import {
  parseLlangRequest,
  parseLlangSuite,
  requestRevision,
} from "./llang-capability";
import { checkLlangProgram } from "./llang-program";
import {
  decodeUtf8,
  LLANG_SOURCE_BYTES,
  parseStrictJsonObject,
} from "./llang-jsonc";
import { WasmError } from "./wasm-contract";

async function regularJson(path: string) {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink())
    throw new WasmError(
      "INVALID_SOURCE",
      "legacy input must be a regular non-symlink file",
    );
  if (info.size > LLANG_SOURCE_BYTES)
    throw new WasmError("INVALID_SOURCE", "legacy input exceeds size limit");
  const bytes = await readFile(absolute);
  if (bytes.byteLength > LLANG_SOURCE_BYTES)
    throw new WasmError("INVALID_SOURCE", "legacy input exceeds size limit");
  return parseStrictJsonObject(decodeUtf8(bytes, absolute), absolute);
}

export async function migratePromptSource(
  sourcePath: string,
  outputPath: string,
) {
  if (!resolve(outputPath).endsWith(".llang.jsonc"))
    throw new WasmError(
      "INVALID_SOURCE",
      "migration output must use .llang.jsonc",
    );
  const source = parsePromptSource(await regularJson(sourcePath));
  const lock = parseResolutionLock(
    await regularJson(`${sourcePath}.lock.json`),
    source,
  );
  const program = {
    language: "l-lang",
    version: 1,
    id: source.id,
    profile: source.profile,
    description: `Migrated from ${source.id} Prompt Source v1; review the SAAA request snapshot before release.`,
    contract: source.contract,
    body: lock.body,
  };
  const text = `// Migrated deterministically from Prompt Source v1 and its validated Resolution Lock.\n${JSON.stringify(program, null, 2)}\n`;
  if (!checkLlangProgram(text, outputPath).checked)
    throw new WasmError("INVALID_SOURCE", "migrated program failed validation");
  const request = parseLlangRequest({
    version: 2,
    id: source.id,
    body: source.intent,
    profile: source.profile,
    contract: source.contract,
    requirements: source.requirements,
  });
  const suite = parseLlangSuite(
    {
      version: 2,
      requestRevision: requestRevision(request),
      contractHash: contentHash(request.contract),
      cases: source.examples.map((example) => ({
        id: example.id,
        requirementIds: [],
        input: example.input,
        undefinedFields: example.undefinedFields,
        expected: { kind: "value", value: example.expected },
      })),
    },
    request,
  );
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  // All outputs use exclusive creation: migration never overwrites authored work.
  const created: string[] = [];
  try {
    await writeFile(destination, text, { flag: "wx" });
    created.push(destination);
    const requestPath = `${destination}.request.json`;
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
      flag: "wx",
    });
    created.push(requestPath);
    const testsPath = `${destination}.tests.json`;
    await writeFile(testsPath, `${JSON.stringify(suite, null, 2)}\n`, {
      flag: "wx",
    });
    created.push(testsPath);
    return {
      source: destination,
      request: requestPath,
      tests: testsPath,
      legacySourceHash: lock.sourceHash,
      apiCalls: 0,
      warnings: [
        "Legacy requirements were preserved, but examples had no requirement links; coverage gaps remain visible until SAAA assigns them.",
      ],
    };
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    for (const path of created) await rm(path, { force: true });
    throw error;
  }
}
