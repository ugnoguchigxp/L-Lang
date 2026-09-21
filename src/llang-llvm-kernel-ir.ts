import {
  COLLECTION_LIMITS,
  type CheckedCollectionProgram,
  type CollectionExpression,
  type CollectionType,
} from "./llang-module-collection-ir";
import { fingerprintFor } from "./stable-hash";

export const LLVM_KERNEL_PLAN_VERSION = 1 as const;

export type LlvmKernelPlanV1 = Readonly<{
  format: "llang-llvm-kernel-plan";
  version: typeof LLVM_KERNEL_PLAN_VERSION;
  operation: "checked-sum-i32";
  sourceProgramHash: string;
  sourceLoweredHash: string;
  inputField: "values";
  outputField: "total";
  maximumElements: 4096;
  overflow: "first-checked-add";
  hash: string;
}>;

const unsupported = (): never => {
  throw new Error(
    "UNSUPPORTED_LLVM_EXPERIMENT: expected checked sum(List<i32>)",
  );
};

const isI32 = (type: CollectionType | undefined) => type?.kind === "i32";
const isListI32 = (type: CollectionType | undefined) =>
  type?.kind === "list" && type.element.kind === "i32";
const isLocal = (expression: CollectionExpression | undefined, name: string) =>
  expression?.kind === "local" && expression.name === name;

export function extractLlvmKernelPlan(
  program: CheckedCollectionProgram,
): LlvmKernelPlanV1 {
  const entry = program.functions.find((item) => item.symbol === program.entry);
  if (
    !entry?.export ||
    entry.typeParameters.length !== 0 ||
    entry.parameters.length !== 1 ||
    entry.parameterTypes.length !== 1 ||
    entry.returnType.kind !== "record" ||
    entry.parameterTypes[0]?.kind !== "record" ||
    entry.parameterTypes[0].fields.length !== 1 ||
    entry.returnType.fields.length !== 1 ||
    entry.parameterTypes[0].fields[0]?.name !== "values" ||
    !isListI32(entry.parameterTypes[0].fields[0]?.type) ||
    entry.returnType.fields[0]?.name !== "total" ||
    !isI32(entry.returnType.fields[0]?.type) ||
    entry.body.result !== undefined ||
    entry.body.statements.length !== 2
  )
    return unsupported();

  const [binding, returned] = entry.body.statements;
  if (
    binding?.kind !== "const" ||
    binding.name !== "total" ||
    binding.type !== "i32" ||
    binding.value.kind !== "intrinsic" ||
    binding.value.name !== "fold" ||
    binding.value.typeArguments.length !== 0 ||
    binding.value.arguments.length !== 3 ||
    returned?.kind !== "return" ||
    returned.value.kind !== "record" ||
    returned.value.fields.length !== 1 ||
    returned.value.fields[0]?.name !== "total" ||
    !isLocal(returned.value.fields[0]?.value, "total")
  )
    return unsupported();

  const [list, initial, callback] = binding.value.arguments;
  if (
    list?.kind !== "field" ||
    list.name !== "values" ||
    !isLocal(list.base, entry.parameters[0]?.name ?? "") ||
    initial?.kind !== "literal" ||
    initial.type !== "i32" ||
    initial.value !== 0 ||
    callback?.kind !== "lambda" ||
    callback.parameters.length !== 2 ||
    callback.parameters[0]?.type !== "i32" ||
    callback.parameters[1]?.type !== "i32" ||
    callback.returns !== "i32" ||
    callback.body.statements.length !== 0 ||
    callback.body.result?.kind !== "binary" ||
    callback.body.result.op !== "+" ||
    !isLocal(callback.body.result.left, callback.parameters[0]?.name ?? "") ||
    !isLocal(callback.body.result.right, callback.parameters[1]?.name ?? "")
  )
    return unsupported();

  const value = {
    format: "llang-llvm-kernel-plan" as const,
    version: LLVM_KERNEL_PLAN_VERSION,
    operation: "checked-sum-i32" as const,
    sourceProgramHash: program.programHash,
    sourceLoweredHash: program.loweredHash,
    inputField: "values" as const,
    outputField: "total" as const,
    maximumElements: COLLECTION_LIMITS.listElements,
    overflow: "first-checked-add" as const,
  };
  return Object.freeze({ ...value, hash: fingerprintFor(value) });
}

export function assertLlvmKernelPlan(value: unknown): LlvmKernelPlanV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_LLVM_KERNEL_PLAN");
  const candidate = value as Record<string, unknown>,
    keys = Object.keys(candidate).sort().join(","),
    expected = [
      "format",
      "hash",
      "inputField",
      "maximumElements",
      "operation",
      "outputField",
      "overflow",
      "sourceLoweredHash",
      "sourceProgramHash",
      "version",
    ]
      .sort()
      .join(","),
    hashPattern = /^[0-9a-f]{64}$/;
  if (
    keys !== expected ||
    candidate.format !== "llang-llvm-kernel-plan" ||
    candidate.version !== 1 ||
    candidate.operation !== "checked-sum-i32" ||
    candidate.inputField !== "values" ||
    candidate.outputField !== "total" ||
    candidate.maximumElements !== 4096 ||
    candidate.overflow !== "first-checked-add" ||
    typeof candidate.sourceProgramHash !== "string" ||
    !hashPattern.test(candidate.sourceProgramHash) ||
    typeof candidate.sourceLoweredHash !== "string" ||
    !hashPattern.test(candidate.sourceLoweredHash) ||
    typeof candidate.hash !== "string" ||
    !hashPattern.test(candidate.hash)
  )
    throw new Error("INVALID_LLVM_KERNEL_PLAN");
  const { hash, ...body } = candidate;
  if (fingerprintFor(body) !== hash)
    throw new Error("INVALID_LLVM_KERNEL_PLAN: hash mismatch");
  return Object.freeze(candidate as LlvmKernelPlanV1);
}
