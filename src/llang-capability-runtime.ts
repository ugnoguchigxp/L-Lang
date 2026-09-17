export { verifyLlangCapability } from "./llang-capability-verifier";
import { executeCases } from "./llang-case-runner";
import { link, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  buildLlangProgram,
  parseLlangBuildManifest,
  readLlangArtifact,
} from "./llang-build";
import {
  caseInput,
  type FileRef,
  json,
  parseLlangCapabilityManifest,
  parseLlangCapabilityMetadata,
  parseLlangRequest,
  parseLlangSuite,
  readLlangCapability,
  regularBytes,
  requirementCoverage,
  type Role,
  roles,
  requestRevision,
} from "./llang-capability-contracts";
import { decodeUtf8 } from "./llang-jsonc";
import { checkLlangProgram } from "./llang-program";
import { contentHash } from "./prompt-source";
import { digest, encodeInput, WasmError } from "./wasm-contract";
import { instantiateWasmPredicate } from "./wasm-runtime";
import {
  enumerateObservations,
  generateMutations,
} from "./capability-mutation";
import { evaluatePromptIR } from "./prompt-resolution";

export async function runLlangSuite(
  sourcePath: string,
  requestPath: string,
  suitePath: string,
) {
  if (!sourcePath.endsWith(".llang.jsonc"))
    throw new WasmError("INVALID_SOURCE", "source must use .llang.jsonc");
  const [sourceBytes, requestBytes, suiteBytes] = await Promise.all([
    regularBytes(resolve(sourcePath)),
    regularBytes(resolve(requestPath)),
    regularBytes(resolve(suitePath)),
  ]);
  return runLlangSuiteSnapshot(
    decodeUtf8(sourceBytes, sourcePath),
    json(requestBytes, requestPath),
    json(suiteBytes, suitePath),
  );
}

/** In-memory inputs are validated and captured synchronously before compilation yields. */
export async function runLlangSuiteSnapshot(
  sourceText: string,
  requestInput: unknown,
  suiteInput: unknown,
) {
  const request = structuredClone(parseLlangRequest(requestInput));
  const checked = checkLlangProgram(sourceText, "snapshot.llang.jsonc").checked;
  if (!checked) throw new WasmError("INVALID_SOURCE", "source failed lint");
  if (
    checked.program.id !== request.id ||
    contentHash(checked.program.contract) !== contentHash(request.contract)
  )
    throw new WasmError(
      "INVALID_CAPABILITY",
      "request/source contract mismatch",
    );
  const suite = parseLlangSuite(suiteInput, request);
  const temporary = await mkdtemp(resolve(tmpdir(), "llang-test-"));
  try {
    // Compile the exact bytes already checked against the request.
    const capturedPath = resolve(temporary, "snapshot.llang.jsonc");
    await writeFile(capturedPath, sourceText, { flag: "wx" });
    const built = await buildLlangProgram(capturedPath, temporary);
    const artifact = await readLlangArtifact(built.manifest);
    const predicate = await instantiateWasmPredicate(
      artifact.manifest,
      artifact.bytes,
    );
    return {
      version: 2 as const,
      requestRevision: requestRevision(request),
      suiteHash: contentHash(suite),
      sourceHash: checked.sourceHash,
      programHash: checked.programHash,
      artifactHash: artifact.manifest.wasmHash,
      apiCalls: 0,
      ...requirementCoverage(request, suite),
      results: executeCases(suite, predicate.evaluate),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function packageLlangCapability(
  sourcePath: string,
  requestPath: string,
  suitePath: string,
  metadataInput: unknown,
  outputDirectory: string,
  write: typeof writeFile = writeFile,
) {
  const metadata = parseLlangCapabilityMetadata(metadataInput);
  const captured = (await Promise.all(
    [requestPath, sourcePath, suitePath].map((item) =>
      regularBytes(resolve(item)),
    ),
  )) as [Buffer, Buffer, Buffer];
  const request = parseLlangRequest(json(captured[0], requestPath));
  const checked = checkLlangProgram(
    decodeUtf8(captured[1], sourcePath),
    sourcePath,
  ).checked;
  if (!checked) throw new WasmError("INVALID_SOURCE", "source failed lint");
  parseLlangSuite(json(captured[2], suitePath), request);
  if (
    metadata.id !== request.id ||
    checked.program.id !== request.id ||
    contentHash(checked.program.contract) !== contentHash(request.contract)
  )
    throw new WasmError(
      "INVALID_CAPABILITY",
      "metadata/request/source mismatch",
    );
  const directory = resolve(outputDirectory);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  try {
    const names = {
      request: "request.json",
      source: `${request.id}.llang.jsonc`,
      tests: "tests.json",
    } as const;
    await write(resolve(directory, names.request), captured[0], {
      flag: "wx",
    });
    await write(resolve(directory, names.source), captured[1], {
      flag: "wx",
    });
    await write(resolve(directory, names.tests), captured[2], {
      flag: "wx",
    });
    const built = await buildLlangProgram(
      resolve(directory, names.source),
      directory,
    );
    const build = parseLlangBuildManifest(
      json(await regularBytes(built.manifest), built.manifest),
    );
    const paths: Record<Role, string> = {
      request: names.request,
      source: names.source,
      tests: names.tests,
      build: "manifest.json",
      wasm: build.file,
    };
    const files = {} as Record<Role, FileRef>;
    for (const role of roles)
      files[role] = {
        path: paths[role],
        hash: digest(await regularBytes(resolve(directory, paths[role]))),
      };
    const manifest = parseLlangCapabilityManifest({
      version: 2,
      metadata,
      profile: "predicate-i32-v1",
      output: "boolean",
      permissions: [],
      files,
    });
    for (let index = 0; index < captured.length; index++)
      if (
        digest(
          await regularBytes(
            resolve([requestPath, sourcePath, suitePath][index] as string),
          ),
        ) !== digest(captured[index] as Buffer)
      )
        throw new WasmError(
          "SOURCE_CONFLICT",
          "input changed during packaging",
        );
    const pending = resolve(directory, "capability.pending");
    const path = resolve(directory, "capability.json");
    await write(pending, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    await link(pending, path);
    await unlink(pending);
    const snapshot = await readLlangCapability(path);
    return {
      manifest: path,
      packageHash: snapshot.packageHash,
      verification: "not-run",
      acceptance: "not-run",
      apiCalls: 0,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function checkLlangMutations(
  sourcePath: string,
  requestPath: string,
  suitePath: string,
) {
  const request = parseLlangRequest(
    json(await regularBytes(resolve(requestPath)), requestPath),
  );
  const suite = parseLlangSuite(
    json(await regularBytes(resolve(suitePath)), suitePath),
    request,
  );
  const checked = checkLlangProgram(
    decodeUtf8(await regularBytes(resolve(sourcePath)), sourcePath),
    sourcePath,
  ).checked;
  if (
    !checked ||
    checked.program.id !== request.id ||
    contentHash(checked.program.contract) !== contentHash(request.contract)
  )
    throw new WasmError("INVALID_CAPABILITY", "source/request mismatch");
  const generated = generateMutations(
    checked.program.body,
    checked.program.contract,
  );
  const results = generated.mutations.map((mutation) => {
    const domain = enumerateObservations(checked.program.contract);
    const counterexample = domain.inputs.find((observation) => {
      const input = caseInput(observation);
      return (
        evaluatePromptIR(checked.program.body, input) !==
        evaluatePromptIR(mutation.body, input)
      );
    });
    const relation = counterexample
      ? "different"
      : domain.exhaustive
        ? "equivalent"
        : "unknown";
    const killedBy = suite.cases
      .filter((item) => {
        try {
          encodeInput(checked.program.contract, caseInput(item));
          const actual = {
            kind: "value",
            value: evaluatePromptIR(mutation.body, caseInput(item)),
          };
          return JSON.stringify(actual) !== JSON.stringify(item.expected);
        } catch {
          return item.expected.kind !== "error";
        }
      })
      .map((item) => item.id);
    return {
      id: `${mutation.operation}:${mutation.irHash}`,
      status:
        relation === "equivalent"
          ? "equivalent"
          : killedBy.length
            ? "killed"
            : relation === "different"
              ? "survived"
              : "unknown",
      relation,
      counterexample: counterexample ?? null,
      killedBy,
    };
  });
  const killed = results.filter((item) => item.status === "killed").length;
  const scored = results.filter((item) => item.status !== "equivalent").length;
  return {
    version: 2,
    sourceHash: checked.sourceHash,
    programHash: checked.programHash,
    suiteHash: contentHash(suite),
    ...requirementCoverage(request, suite),
    mutations: results,
    score: scored ? killed / scored : 1,
    proposed: generated.proposed,
    omittedProposals: generated.omittedProposals,
    invalidProposals: generated.invalidProposals,
    duplicates: generated.duplicates,
    apiCalls: 0,
  };
}
