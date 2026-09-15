import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readCapability, verifyCapability } from "./capability-package";
import { caseInput, invalid } from "./capability-tests";
import { type PredicateExpression, parsePredicateExpression } from "./ir";
import { evaluatePromptIR } from "./prompt-resolution";
import { contentHash, exampleInput, type PromptSource } from "./prompt-source";
import { saveArtifact } from "./wasm-artifact";
import { digest, type WasmContract } from "./wasm-contract";
import { lowerPredicate } from "./wasm-core";

type WireInput = { input: Record<string, unknown>; undefinedFields: string[] };
type Path = ("condition" | number)[];
type Mutation = {
  path: Path;
  operation: string;
  body: PredicateExpression;
  irHash: string;
};
export function generateMutations(
  body: PredicateExpression,
  contract: WasmContract,
) {
  function* proposals(
    node: PredicateExpression,
    path: Path,
  ): Generator<{
    path: Path;
    operation: string;
    replacement: PredicateExpression;
  }> {
    yield {
      path,
      operation: node.kind === "not" ? "remove-not" : "negate",
      replacement:
        node.kind === "not" ? node.condition : { kind: "not", condition: node },
    };
    if (node.kind === "all" || node.kind === "any") {
      yield {
        path,
        operation: "swap-all-any",
        replacement: { ...node, kind: node.kind === "all" ? "any" : "all" },
      };
      if (node.conditions.length > 1)
        for (let i = 0; i < node.conditions.length; i++)
          yield {
            path,
            operation: `remove-condition-${i}`,
            replacement: {
              ...node,
              conditions: node.conditions.filter((_, j) => i !== j),
            },
          };
      for (let i = 0; i < node.conditions.length; i++)
        yield* proposals(node.conditions[i] as PredicateExpression, [
          ...path,
          i,
        ]);
    } else if (node.kind === "not")
      yield* proposals(node.condition, [...path, "condition"]);
    else if (node.kind === "equals") {
      const field = contract.fields.find((f) => f.name === node.property[0]);
      const alternatives =
        typeof node.value === "boolean"
          ? [!node.value]
          : field?.kind === "enum"
            ? field.values.filter((v) => v !== node.value)
            : [];
      for (const value of alternatives)
        yield {
          path,
          operation: `change-equality-${JSON.stringify(value)}`,
          replacement: { ...node, value },
        };
    }
  }
  function replace(
    node: PredicateExpression,
    path: Path,
    replacement: PredicateExpression,
  ): PredicateExpression {
    if (!path.length) return replacement;
    const [head, ...tail] = path;
    if (head === "condition" && node.kind === "not")
      return { ...node, condition: replace(node.condition, tail, replacement) };
    if (
      typeof head === "number" &&
      (node.kind === "all" || node.kind === "any")
    )
      return {
        ...node,
        conditions: node.conditions.map((c, i) =>
          i === head ? replace(c, tail, replacement) : c,
        ),
      };
    return invalid("invalid mutation path");
  }
  const mutations: Mutation[] = [],
    seen = new Set([contentHash(body)]);
  let proposed = 0,
    omittedProposals = 0,
    invalidProposals = 0,
    duplicates = 0;
  for (const p of proposals(body, [])) {
    proposed++;
    if (mutations.length >= 32) {
      omittedProposals++;
      continue;
    }
    let modified: PredicateExpression;
    try {
      modified = parsePredicateExpression(replace(body, p.path, p.replacement));
      lowerPredicate(modified, contract);
    } catch {
      invalidProposals++;
      continue;
    }
    const irHash = contentHash(modified);
    if (seen.has(irHash)) {
      duplicates++;
      continue;
    }
    seen.add(irHash);
    mutations.push({
      path: p.path,
      operation: p.operation,
      body: modified,
      irHash,
    });
  }
  return {
    mutations,
    proposed,
    omittedProposals,
    invalidProposals,
    duplicates,
  };
}
export function enumerateObservations(contract: WasmContract) {
  const domains = contract.fields.map((f) => {
    // Explicit undefined and absent properties are distinct adapter inputs.
    const options: ({ kind: "missing" } | { kind: "value"; value: unknown })[] =
      [];
    if (f.optional) options.push({ kind: "missing" });
    if (f.undefinable) options.push({ kind: "value", value: undefined });
    if (f.nullable) options.push({ kind: "value", value: null });
    for (const value of f.kind === "boolean"
      ? [false, true]
      : f.kind === "enum"
        ? f.values
        : [""])
      options.push({ kind: "value", value });
    return options;
  });
  const inputs: WireInput[] = [];
  let size = 1;
  for (const d of domains) size = Math.min(4097, size * d.length);
  function visit(
    index: number,
    input: Record<string, unknown>,
    undefinedFields: string[],
  ) {
    if (inputs.length >= 4096) return;
    if (index === domains.length) {
      inputs.push({ input, undefinedFields });
      return;
    }
    const field = contract.fields[index];
    if (!field) return;
    for (const item of domains[index] ?? []) {
      if (item.kind === "missing")
        visit(index + 1, { ...input }, [...undefinedFields]);
      else if (item.value === undefined)
        visit(index + 1, { ...input }, [...undefinedFields, field.name]);
      else
        visit(index + 1, { ...input, [field.name]: item.value }, [
          ...undefinedFields,
        ]);
      if (inputs.length >= 4096) break;
    }
  }
  visit(0, {}, []);
  return { inputs, exhaustive: size <= 4096, limit: 4096 };
}
export function compareMutation(
  source: PromptSource,
  original: PredicateExpression,
  mutant: PredicateExpression,
) {
  const domain = enumerateObservations(source.contract);
  const counterexample =
    domain.inputs.find(
      (w) =>
        evaluatePromptIR(original, caseInput(w)) !==
        evaluatePromptIR(mutant, caseInput(w)),
    ) ?? null;
  return {
    relation: counterexample
      ? "different"
      : domain.exhaustive
        ? "equivalent"
        : "unknown",
    counterexample,
    observations: domain.inputs.length,
    exhaustive: domain.exhaustive,
  };
}
export async function checkCapabilityMutations(path: string) {
  const snapshot = await readCapability(path);
  const base = await verifyCapability(path);
  if (base.status !== "pass" || base.packageHash !== snapshot.packageHash)
    invalid("mutation check requires a passing unchanged candidate");
  const generated = generateMutations(
    snapshot.lock.body,
    snapshot.source.contract,
  );
  const root = await mkdtemp(resolve(tmpdir(), "capability-mutations-"));
  const results: {
    path: Path;
    operation: string;
    irHash: string;
    relation: string;
    counterexample: WireInput | null;
    status:
      | "killed-source"
      | "killed-suite"
      | "survived"
      | "equivalent"
      | "unknown"
      | "error";
    diagnostic: string | null;
    observations: number;
    exhaustive: boolean;
  }[] = [];
  try {
    const { emitWasm } = await import("./wasm-emitter");
    const { runIsolatedCapability } = await import("./capability-package");
    for (const mutation of generated.mutations) {
      const comparison = compareMutation(
        snapshot.source,
        snapshot.lock.body,
        mutation.body,
      );
      let status: (typeof results)[number]["status"] = "error",
        diagnostic: string | null = null;
      try {
        if (comparison.relation === "equivalent") status = "equivalent";
        else if (
          snapshot.source.examples.some(
            (e) =>
              evaluatePromptIR(mutation.body, exampleInput(e)) !== e.expected,
          )
        )
          status = "killed-source";
        else {
          const bytes = emitWasm(mutation.body, snapshot.source.contract);
          const build = {
            ...snapshot.build,
            wasmHash: digest(bytes),
            file: `${digest(bytes)}.wasm`,
            irHash: digest(JSON.stringify(mutation.body)),
          };
          // Only a temporary low-level build: no Source Lock or candidate is published.
          await saveArtifact(
            resolve(root, String(results.length)),
            bytes,
            build,
          );
          const cases = await runIsolatedCapability({
            ...snapshot,
            build,
            bytes,
          });
          if (cases.some((c) => c.status === "error")) status = "error";
          else if (cases.some((c) => c.status === "fail"))
            status = "killed-suite";
          else
            status =
              comparison.relation === "different" ? "survived" : "unknown";
        }
      } catch (error) {
        diagnostic = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 4096);
      }
      results.push({
        path: mutation.path,
        operation: mutation.operation,
        irHash: mutation.irHash,
        ...comparison,
        status,
        diagnostic,
      });
    }
    if ((await readCapability(path)).packageHash !== snapshot.packageHash)
      invalid("candidate changed during mutation check");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return {
    version: 1,
    protocol: "capability-mutation-v1",
    packageHash: snapshot.packageHash,
    originalIRHash: contentHash(snapshot.lock.body),
    acceptance: "not-run",
    apiCalls: 0,
    complete: true,
    proposed: generated.proposed,
    omittedProposals: generated.omittedProposals,
    invalidProposals: generated.invalidProposals,
    duplicates: generated.duplicates,
    results,
    counts: Object.fromEntries(
      [
        "killed-source",
        "killed-suite",
        "survived",
        "equivalent",
        "unknown",
        "error",
      ].map((s) => [s, results.filter((r) => r.status === s).length]),
    ),
  };
}
