import { basename, extname, resolve } from "node:path";
import { validatePredicateContext } from "./context-validator";
import { generatePredicate } from "./generator";
import { parsePredicateDefinition, parsePredicateExpression } from "./ir";
import { buildProjectContext } from "./project-context";
import {
  predicateSemanticHashes,
  sha256,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import { findReplayEntry, readSemanticLockSnapshot } from "./semantic-lock";
import { scanSemanticSource } from "./semantic-source";
import { WasmError } from "./wasm-contract";

// Legacy locks bind IR through the deterministic TS digest. No TS file is
// emitted or executed: rendering here is solely a backwards-compatibility check.
export async function readSemanticResolution(
  sourcePath: string,
  workspaceRoot = process.cwd(),
  lockPath = resolve(workspaceRoot, "semantic.lock"),
) {
  const source = await scanSemanticSource(sourcePath);
  const relative = workspaceRelativePath(
    workspaceRoot,
    source.absolutePath,
    "semantic source",
  );
  const { lock, revision } = await readSemanticLockSnapshot(lockPath);
  if (revision === null)
    throw new WasmError(
      "LOCK_MISSING",
      "prepare a semantic.lock before building Wasm",
    );
  const context = await buildProjectContext({ source, workspaceRoot, lock });
  const hashes = predicateSemanticHashes(source, context);
  const entry = findReplayEntry(lock, {
    source: relative,
    predicate: source.predicate.name,
    conceptId: source.concept.id,
    ...hashes,
  });
  if (!entry)
    throw new WasmError(
      "LOCK_STALE",
      "no resolution matches source, type, tests, prompt and context",
    );
  const body = parsePredicateExpression(entry.resolvedIr);
  validatePredicateContext(body, source);
  const definition = parsePredicateDefinition({
    version: 1,
    name: source.predicate.name,
    description: source.concept.specification,
    input: {
      parameter: source.predicate.parameterName,
      type: source.concept.typeName,
      module: `./${basename(source.absolutePath, extname(source.absolutePath))}`,
    },
    returns: "boolean",
    body,
  });
  if (sha256(generatePredicate(definition)) !== entry.generatedCodeHash)
    throw new WasmError("INVALID_IR", "legacy resolution integrity mismatch");
  return {
    body,
    schema: source.concept.typeSchema,
    provenance: {
      source: relative,
      concept: source.concept.id,
      predicate: source.predicate.name,
      fingerprint: entry.fingerprint,
      ...hashes,
    },
  };
}
