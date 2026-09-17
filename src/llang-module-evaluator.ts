import { encodeInput, type WasmContract } from "./wasm-contract";
import {
  MODULE_LIMITS,
  ModuleError,
  type CheckedFunction,
  type CheckedModuleProgram,
  type ModuleExpression,
  type ResolvedType,
} from "./llang-module-ir";

type RuntimeValue = boolean | Record<string, boolean>;

export function moduleEntryContract(
  program: CheckedModuleProgram,
): WasmContract {
  const entry = program.functions.find((fn) => fn.symbol === program.entry);
  const type = entry?.parameters[0]?.type;
  if (type?.kind !== "record")
    throw new ModuleError("LLM004", "invalid entry contract");
  return {
    version: 1,
    fields: type.fields.map((name) => ({
      name,
      kind: "boolean" as const,
      values: [],
      nullable: false,
      undefinable: false,
      optional: false,
    })),
  };
}

export function evaluateModuleProgram(
  program: CheckedModuleProgram,
  input: unknown,
  stepBudget = MODULE_LIMITS.evaluationSteps,
): boolean {
  const contract = moduleEntryContract(program);
  encodeInput(contract, input);
  const functions = new Map(program.functions.map((fn) => [fn.symbol, fn]));
  let steps = 0;
  const invoke = (fn: CheckedFunction, args: RuntimeValue[]): boolean => {
    const values = new Map(
      fn.parameters.map((p, index) => [p.name, args[index] as RuntimeValue]),
    );
    const evaluate = (expression: ModuleExpression): RuntimeValue => {
      if (++steps > stepBudget)
        throw new ModuleError(
          "EVALUATION_LIMIT",
          "evaluation step budget exceeded",
        );
      switch (expression.kind) {
        case "literal":
          return expression.value;
        case "param": {
          const value = values.get(expression.name);
          if (value === undefined)
            throw new ModuleError("LLM004", "unknown parameter");
          return value;
        }
        case "field": {
          const value = values.get(expression.base.name);
          if (!value || typeof value !== "object")
            throw new ModuleError("LLM004", "invalid field base");
          return value[expression.name] as boolean;
        }
        case "not":
          return !evaluate(expression.condition);
        case "all":
          for (const condition of expression.conditions)
            if (!evaluate(condition)) return false;
          return true;
        case "any":
          for (const condition of expression.conditions)
            if (evaluate(condition)) return true;
          return false;
        case "equals":
          return evaluate(expression.left) === evaluate(expression.right);
        case "call": {
          const symbol = fn.callees[expression.callee],
            target = symbol ? functions.get(symbol) : undefined;
          if (!target) throw new ModuleError("LLM004", "unknown callee");
          return invoke(target, expression.arguments.map(evaluate));
        }
      }
    };
    const result = evaluate(fn.body);
    if (typeof result !== "boolean")
      throw new ModuleError("LLM004", "function did not return boolean");
    return result;
  };
  const entry = functions.get(program.entry);
  if (!entry) throw new ModuleError("LLM004", "entry not found");
  return invoke(entry, [input as Record<string, boolean>]);
}

export function scalarSlots(type: ResolvedType): number {
  return type.kind === "boolean" ? 1 : type.fields.length;
}
