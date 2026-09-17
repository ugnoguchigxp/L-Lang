import binaryen from "binaryen";
import {
  type CheckedValueFunction,
  type CheckedValueProgram,
  type ValueExpression,
  type ValueType,
} from "./llang-module-value-ir";
import {
  VALUE_ABI,
  VALUE_MEMORY_PAGES,
  layoutValueType,
} from "./llang-value-abi";

export type ValueWasmContract = {
  abi: typeof VALUE_ABI;
  memory: { initial: 16; maximum: 16 };
  inputType: unknown;
  outputType: unknown;
  layoutHash: string;
  inputLimit: number;
  outputLimit: number;
};
const watName = (value: string) => `$${Buffer.from(value).toString("hex")}`;
type EmitContext = {
  fn: CheckedValueFunction;
  locals: Map<string, ValueType>;
  types: Map<string, ValueType>;
  functions: Map<string, CheckedValueFunction>;
  constants: Map<string, { name: string; bytes: Uint8Array }>;
  temp: () => string;
};

function collectTypes(program: CheckedValueProgram): Map<string, ValueType> {
  const result = new Map<string, ValueType>();
  const visit = (type: ValueType) => {
    if (type.kind === "record" || type.kind === "union") {
      result.set(type.symbol, type);
      const fields =
        type.kind === "record"
          ? type.fields
          : type.variants.flatMap((x) => x.fields);
      fields.forEach((x) => {
        visit(x.type);
      });
    }
  };
  visit(program.entryInput);
  visit(program.entryOutput);
  program.types.forEach(visit);
  program.functions.forEach((f) => {
    f.parameters.forEach((p) => {
      visit(p.type);
    });
    visit(f.returns);
  });
  return result;
}
function sourceType(ctx: EmitContext, name: string): ValueType {
  const symbol = ctx.fn.typeBindings[name],
    type = symbol ? ctx.types.get(symbol) : undefined;
  if (type) return type;
  throw new Error(`INVALID_IR: unknown type ${name}`);
}
function infer(ctx: EmitContext, expr: ValueExpression): ValueType {
  switch (expr.kind) {
    case "literal":
      return { kind: expr.type };
    case "param":
    case "local": {
      const type = ctx.locals.get(expr.name);
      if (!type) throw new Error(`INVALID_IR: unknown local ${expr.name}`);
      return type;
    }
    case "field": {
      const base = infer(ctx, expr.base),
        fields =
          base.kind === "record"
            ? base.fields
            : base.kind === "union"
              ? base.variants.flatMap((x) => x.fields)
              : [];
      const field = fields.find((x) => x.name === expr.name);
      if (!field) throw new Error("INVALID_IR: field");
      return field.type;
    }
    case "unary":
      return { kind: expr.op === "not" ? "boolean" : "i32" };
    case "binary":
      return {
        kind: ["+", "-", "*", "/", "%"].includes(expr.op) ? "i32" : "boolean",
      };
    case "call": {
      const target = ctx.functions.get(ctx.fn.callees[expr.callee] ?? "");
      if (!target) throw new Error("INVALID_IR: call");
      return target.returns;
    }
    case "intrinsic":
      return { kind: expr.name === "concat" ? "string" : "i32" };
    case "record":
    case "variant":
      return sourceType(ctx, expr.type);
    case "block": {
      const prior = new Map(ctx.locals);
      for (const b of expr.bindings)
        ctx.locals.set(b.name, infer(ctx, b.value));
      const result = infer(ctx, expr.result);
      ctx.locals = prior;
      return result;
    }
    case "if":
      return infer(ctx, expr.whenTrue);
    case "match":
      return infer(ctx, expr.cases[0]!.body);
  }
}
function load(type: ValueType, address: string): string {
  if (type.kind === "boolean")
    return `(i64.extend_i32_u (i32.load ${address}))`;
  if (type.kind === "i32") return `(i64.extend_i32_s (i32.load ${address}))`;
  if (type.kind === "string")
    return `(call $pack (i32.load ${address}) (i32.load offset=4 ${address}))`;
  return `(i64.extend_i32_u ${address})`;
}
function store(type: ValueType, address: string, value: string): string[] {
  if (type.kind === "boolean" || type.kind === "i32")
    return [`(i32.store ${address} (i32.wrap_i64 ${value}))`];
  if (type.kind === "string")
    return [
      `(i32.store ${address} (call $ptr ${value}))`,
      `(i32.store offset=4 ${address} (call $len ${value}))`,
    ];
  return [
    `(call $mem_copy ${address} (i32.wrap_i64 ${value}) (i32.const ${layoutValueType(type).size}))`,
  ];
}
function expressionLocals(
  expr: ValueExpression,
  ctx: EmitContext,
  output = new Map<string, ValueType>(),
): Map<string, ValueType> {
  const visit = (x: ValueExpression) => expressionLocals(x, ctx, output);
  if (expr.kind === "block") {
    const prior = new Map(ctx.locals);
    for (const b of expr.bindings) {
      const type = infer(ctx, b.value);
      output.set(b.name, type);
      visit(b.value);
      ctx.locals.set(b.name, type);
    }
    visit(expr.result);
    ctx.locals = prior;
  } else if (expr.kind === "match") {
    const type = infer(ctx, expr.value);
    visit(expr.value);
    const prior = new Map(ctx.locals);
    if (type.kind === "union")
      for (const item of expr.cases) {
        ctx.locals = new Map(prior);
        const variant = type.variants.find((x) => x.tag === item.tag);
        for (const field of variant?.fields ?? []) {
          output.set(field.name, field.type);
          ctx.locals.set(field.name, field.type);
        }
        visit(item.body);
      }
    ctx.locals = prior;
  } else if (expr.kind === "field") visit(expr.base);
  else if (expr.kind === "unary") visit(expr.operand);
  else if (expr.kind === "binary") {
    visit(expr.left);
    visit(expr.right);
  } else if (expr.kind === "call" || expr.kind === "intrinsic")
    expr.arguments.forEach((argument) => {
      visit(argument);
    });
  else if (expr.kind === "record" || expr.kind === "variant")
    expr.fields.forEach((x) => {
      visit(x.value);
    });
  else if (expr.kind === "if") {
    visit(expr.condition);
    visit(expr.whenTrue);
    visit(expr.whenFalse);
  }
  return output;
}
function emitExpression(ctx: EmitContext, expr: ValueExpression): string {
  const emit = (x: ValueExpression) => emitExpression(ctx, x),
    guarded = (body: string) =>
      `(if (result i64) (global.get $fault) (then (i64.const 0)) (else (block (result i64) (call $tick) ${body})))`;
  let body: string;
  switch (expr.kind) {
    case "literal": {
      const constant =
        expr.type === "string"
          ? ctx.constants.get(expr.value as string)
          : undefined;
      body = constant
        ? `(call ${constant.name})`
        : `(i64.const ${expr.value === true ? 1 : expr.value === false ? 0 : expr.value})`;
      break;
    }
    case "param":
    case "local":
      body = `(local.get ${watName(expr.name)})`;
      break;
    case "field": {
      const baseType = infer(ctx, expr.base),
        layout = layoutValueType(baseType),
        field =
          baseType.kind === "record"
            ? layout.fields?.find((x) => x.name === expr.name)
            : undefined;
      if (!field)
        throw new Error(
          "INVALID_IR: union fields are only available through match",
        );
      const temp = ctx.temp();
      body = `(block (result i64) (local.set ${temp} ${emit(expr.base)}) ${load(field.type, `(i32.add (i32.wrap_i64 (local.get ${temp})) (i32.const ${field.offset}))`)})`;
      break;
    }
    case "unary":
      body =
        expr.op === "not"
          ? `(i64.extend_i32_u (i64.eqz ${emit(expr.operand)}))`
          : `(call $checked (i64.sub (i64.const 0) ${emit(expr.operand)}))`;
      break;
    case "binary": {
      const a = emit(expr.left),
        b = emit(expr.right);
      if (["+", "-", "*"].includes(expr.op))
        body = `(call $checked (i64.${expr.op === "+" ? "add" : expr.op === "-" ? "sub" : "mul"} ${a} ${b}))`;
      else if (expr.op === "/" || expr.op === "%")
        body = `(call $divrem (i32.const ${expr.op === "/" ? 0 : 1}) ${a} ${b})`;
      else if (expr.op === "&&" || expr.op === "||")
        body = `(if (result i64) (i32.wrap_i64 ${a}) (then ${expr.op === "&&" ? b : "(i64.const 1)"}) (else ${expr.op === "&&" ? "(i64.const 0)" : b}))`;
      else {
        const type = infer(ctx, expr.left),
          op = expr.op;
        if (type.kind === "string")
          body = `(i64.extend_i32_u ${op === "===" ? "" : "(i32.eqz "}(call $str_eq ${a} ${b})${op === "===" ? "" : ")"})`;
        else {
          const wasm =
            op === "==="
              ? "eq"
              : op === "!=="
                ? "ne"
                : op === "<"
                  ? "lt_s"
                  : op === "<="
                    ? "le_s"
                    : op === ">"
                      ? "gt_s"
                      : "ge_s";
          body = `(i64.extend_i32_u (i64.${wasm} ${a} ${b}))`;
        }
      }
      break;
    }
    case "call": {
      const target = ctx.functions.get(ctx.fn.callees[expr.callee] ?? "");
      if (!target) throw new Error("INVALID_IR: call");
      body = `(call ${watName(target.symbol)} ${expr.arguments.map(emit).join(" ")})`;
      break;
    }
    case "intrinsic":
      body =
        expr.name === "concat"
          ? `(call $concat ${emit(expr.arguments[0]!)} ${emit(expr.arguments[1]!)})`
          : `(i64.extend_i32_u (call $scalar_len ${emit(expr.arguments[0]!)}))`;
      break;
    case "record":
    case "variant": {
      const type = sourceType(ctx, expr.type),
        layout = layoutValueType(type),
        temp = ctx.temp(),
        tag = expr.kind === "variant" ? expr.tag : undefined,
        actions = [
          `(local.set ${temp} (i64.extend_i32_u (call $alloc (i32.const ${layout.size}))))`,
          `(call $mem_zero (i32.wrap_i64 (local.get ${temp})) (i32.const ${layout.size}))`,
        ];
      const fields =
        type.kind === "record"
          ? layout.fields!
          : layout.variants!.find((x) => x.tag === tag)!.fields;
      if (type.kind === "union")
        actions.push(
          `(i32.store (i32.wrap_i64 (local.get ${temp})) (i32.const ${layout.variants!.find((x) => x.tag === tag)!.index}))`,
        );
      for (const source of expr.fields) {
        const field = fields.find((x) => x.name === source.name)!,
          address = `(i32.add (i32.wrap_i64 (local.get ${temp})) (i32.const ${field.offset}))`;
        if (field.type.kind === "string") {
          const fieldTemp = ctx.temp();
          actions.push(
            `(local.set ${fieldTemp} ${emit(source.value)})`,
            ...store(field.type, address, `(local.get ${fieldTemp})`),
          );
        } else actions.push(...store(field.type, address, emit(source.value)));
      }
      body = `(block (result i64) ${actions.join(" ")} (local.get ${temp}))`;
      break;
    }
    case "block": {
      const actions: string[] = [],
        prior = new Map(ctx.locals);
      for (const binding of expr.bindings) {
        const type = infer(ctx, binding.value);
        actions.push(
          `(local.set ${watName(binding.name)} ${emit(binding.value)})`,
        );
        ctx.locals.set(binding.name, type);
      }
      const result = emit(expr.result);
      ctx.locals = prior;
      body = `(block (result i64) ${actions.join(" ")} ${result})`;
      break;
    }
    case "if":
      body = `(if (result i64) (i32.wrap_i64 ${emit(expr.condition)}) (then ${emit(expr.whenTrue)}) (else ${emit(expr.whenFalse)}))`;
      break;
    case "match": {
      const valueType = infer(ctx, expr.value);
      if (valueType.kind !== "union") throw new Error("INVALID_IR: match");
      const temp = ctx.temp(),
        layout = layoutValueType(valueType),
        prior = new Map(ctx.locals);
      let chain = `(i64.const 0)`;
      for (let i = expr.cases.length - 1; i >= 0; i--) {
        const item = expr.cases[i]!,
          variant = valueType.variants.find((x) => x.tag === item.tag)!,
          variantLayout = layout.variants!.find((x) => x.tag === item.tag)!,
          binds = variant.fields.flatMap((field) => {
            const placed = variantLayout.fields.find(
              (x) => x.name === field.name,
            )!;
            return [
              `(local.set ${watName(field.name)} ${load(field.type, `(i32.add (i32.wrap_i64 (local.get ${temp})) (i32.const ${placed.offset}))`)})`,
            ];
          });
        ctx.locals = new Map(prior);
        for (const field of variant.fields)
          ctx.locals.set(field.name, field.type);
        const caseBody = emit(item.body);
        chain = `(if (result i64) (i32.eq (i32.load (i32.wrap_i64 (local.get ${temp}))) (i32.const ${variantLayout.index})) (then (block (result i64) ${binds.join(" ")} ${caseBody})) (else ${chain}))`;
      }
      ctx.locals = prior;
      body = `(block (result i64) (local.set ${temp} ${emit(expr.value)}) ${chain})`;
      break;
    }
  }
  return guarded(body);
}
function outputWriter(
  type: ValueType,
  value: string,
  address: string,
): string[] {
  if (type.kind === "boolean" || type.kind === "i32")
    return [`(i32.store ${address} (i32.wrap_i64 ${value}))`];
  if (type.kind === "string")
    return [
      `(local.set $copy (call $out_string ${value}))`,
      `(i32.store ${address} (local.get $copy))`,
      `(i32.store offset=4 ${address} (call $len ${value}))`,
    ];
  const layout = layoutValueType(type),
    actions: string[] = [];
  if (type.kind === "record")
    for (const field of layout.fields!)
      actions.push(
        ...outputWriter(
          field.type,
          load(
            field.type,
            `(i32.add (i32.wrap_i64 ${value}) (i32.const ${field.offset}))`,
          ),
          `(i32.add ${address} (i32.const ${field.offset}))`,
        ),
      );
  else {
    actions.push(`(i32.store ${address} (i32.load (i32.wrap_i64 ${value})))`);
    for (const variant of type.variants) {
      const vl = layout.variants!.find((x) => x.tag === variant.tag)!;
      const writes = variant.fields.flatMap((field) => {
        const fl = vl.fields.find((x) => x.name === field.name)!;
        return outputWriter(
          field.type,
          load(
            field.type,
            `(i32.add (i32.wrap_i64 ${value}) (i32.const ${fl.offset}))`,
          ),
          `(i32.add ${address} (i32.const ${fl.offset}))`,
        );
      });
      actions.push(
        `(if (i32.eq (i32.load (i32.wrap_i64 ${value})) (i32.const ${vl.index})) (then ${writes.join(" ")}))`,
      );
    }
  }
  return actions;
}
function boolOr(items: string[]): string {
  return items.length
    ? items.reduce((a, b) => `(i32.or ${a} ${b})`)
    : `(i32.const 0)`;
}
function invalidInput(type: ValueType, address: string): string {
  const layout = layoutValueType(type);
  if (type.kind === "boolean")
    return `(i32.gt_u (i32.load ${address}) (i32.const 1))`;
  if (type.kind === "i32") return `(i32.const 0)`;
  if (type.kind === "string") {
    const pointer = `(i32.load ${address})`,
      length = `(i32.load offset=4 ${address})`,
      end = `(i32.add ${pointer} ${length})`;
    return boolOr([
      `(i32.gt_u ${length} (i32.const 16384))`,
      `(i32.lt_u ${pointer} (local.get $input))`,
      `(i32.lt_u ${end} ${pointer})`,
      `(i32.gt_u ${end} (i32.add (local.get $input) (local.get $input_len)))`,
      `(i32.eqz (call $utf8_valid ${pointer} ${length}))`,
    ]);
  }
  if (type.kind === "record")
    return boolOr(
      layout.fields!.map((field) =>
        invalidInput(
          field.type,
          `(i32.add ${address} (i32.const ${field.offset}))`,
        ),
      ),
    );
  const tag = `(i32.load ${address})`,
    cases = type.variants.map((variant) => {
      const vl = layout.variants!.find((x) => x.tag === variant.tag)!;
      return `(if (result i32) (i32.eq ${tag} (i32.const ${vl.index})) (then ${boolOr(vl.fields.map((field) => invalidInput(field.type, `(i32.add ${address} (i32.const ${field.offset}))`)))}) (else (i32.const 0)))`;
    });
  return boolOr([
    `(i32.ge_u ${tag} (i32.const ${type.variants.length}))`,
    ...cases,
  ]);
}

export function emitValueModuleWasm(program: CheckedValueProgram): {
  bytes: Uint8Array;
  contract: ValueWasmContract;
  wat: string;
} {
  const functions = new Map(program.functions.map((x) => [x.symbol, x])),
    types = collectTypes(program),
    functionTexts: string[] = [],
    constants = new Map<string, { name: string; bytes: Uint8Array }>();
  let constantBytes = 0;
  const scan = (expr: ValueExpression): void => {
    if (
      expr.kind === "literal" &&
      expr.type === "string" &&
      !constants.has(expr.value as string)
    ) {
      const bytes = new TextEncoder().encode(expr.value as string);
      constants.set(expr.value as string, {
        name: `$const${constants.size}`,
        bytes,
      });
      constantBytes += bytes.length;
    }
    const visit = (x: ValueExpression) => scan(x);
    if (expr.kind === "field") visit(expr.base);
    else if (expr.kind === "unary") visit(expr.operand);
    else if (expr.kind === "binary") {
      visit(expr.left);
      visit(expr.right);
    } else if (expr.kind === "call" || expr.kind === "intrinsic")
      expr.arguments.forEach((argument) => {
        visit(argument);
      });
    else if (expr.kind === "record" || expr.kind === "variant")
      expr.fields.forEach((x) => {
        visit(x.value);
      });
    else if (expr.kind === "block") {
      expr.bindings.forEach((x) => {
        visit(x.value);
      });
      visit(expr.result);
    } else if (expr.kind === "if") {
      visit(expr.condition);
      visit(expr.whenTrue);
      visit(expr.whenFalse);
    } else if (expr.kind === "match") {
      visit(expr.value);
      expr.cases.forEach((x) => {
        visit(x.body);
      });
    }
  };
  program.functions.forEach((x) => {
    scan(x.body);
  });
  if (constantBytes > 65536)
    throw new Error("INVALID_IR: string constants exceed region");
  for (const fn of program.functions) {
    let tempIndex = 0;
    const ctx: EmitContext = {
      fn,
      locals: new Map(fn.parameters.map((x) => [x.name, x.type])),
      types,
      functions,
      constants,
      temp: () => `$tmp${tempIndex++}`,
    };
    const locals = expressionLocals(fn.body, ctx);
    const body = emitExpression(ctx, fn.body),
      tempLocals = Array.from(
        { length: tempIndex },
        (_, i) => `(local $tmp${i} i64)`,
      ).join(" ");
    functionTexts.push(
      `(func ${watName(fn.symbol)} ${fn.parameters.map((p) => `(param ${watName(p.name)} i64)`).join(" ")} (result i64) ${[
        ...locals,
      ]
        .filter(([name]) => !fn.parameters.some((p) => p.name === name))
        .map(([name]) => `(local ${watName(name)} i64)`)
        .join(" ")} ${tempLocals} ${body})`,
    );
  }
  const outputLayout = layoutValueType(program.entryOutput),
    entry = functions.get(program.entry)!;
  const writers = outputWriter(
    program.entryOutput,
    `(local.get $result)`,
    `(local.get $output)`,
  );
  const inputInvalid = invalidInput(program.entryInput, `(local.get $input)`);
  const constantFunctions = [...constants.values()]
    .map(
      (item) =>
        `(func ${item.name} (result i64) (local $p i32) (local.set $p (call $alloc (i32.const ${item.bytes.length}))) ${[...item.bytes].map((byte, index) => `(i32.store8 offset=${index} (local.get $p) (i32.const ${byte}))`).join(" ")} (call $pack (local.get $p) (i32.const ${item.bytes.length})))`,
    )
    .join("\n");
  const wat = `(module
    (memory (export "memory") ${VALUE_MEMORY_PAGES} ${VALUE_MEMORY_PAGES})
    (global $fault (mut i32) (i32.const 0)) (global $fuel (mut i32) (i32.const 0)) (global $arena (mut i32) (i32.const 524288)) (global $out_cursor (mut i32) (i32.const 0)) (global $out_end (mut i32) (i32.const 0))
    (func $pack (param $p i32) (param $n i32) (result i64) (i64.or (i64.extend_i32_u (local.get $p)) (i64.shl (i64.extend_i32_u (local.get $n)) (i64.const 32))))
    (func $ptr (param $v i64) (result i32) (i32.wrap_i64 (local.get $v))) (func $len (param $v i64) (result i32) (i32.wrap_i64 (i64.shr_u (local.get $v) (i64.const 32))))
    (func $tick (if (i32.le_s (global.get $fuel) (i32.const 0)) (then (global.set $fault (i32.const 4))) (else (global.set $fuel (i32.sub (global.get $fuel) (i32.const 1))))))
    (func $mem_copy (param $dst i32) (param $src i32) (param $n i32) (local $i i32) (loop $loop (if (i32.lt_u (local.get $i) (local.get $n)) (then (i32.store8 (i32.add (local.get $dst) (local.get $i)) (i32.load8_u (i32.add (local.get $src) (local.get $i)))) (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $loop)))))
    (func $mem_zero (param $dst i32) (param $n i32) (local $i i32) (loop $loop (if (i32.lt_u (local.get $i) (local.get $n)) (then (i32.store8 (i32.add (local.get $dst) (local.get $i)) (i32.const 0)) (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $loop)))))
    (func $checked (param $v i64) (result i64)
      (if (global.get $fault) (then (return (i64.const 0))))
      (if (i32.or (i64.lt_s (local.get $v) (i64.const -2147483648)) (i64.gt_s (local.get $v) (i64.const 2147483647)))
        (then (global.set $fault (i32.const 2)) (return (i64.const 0))))
      (local.get $v))
    (func $divrem (param $rem i32) (param $a i64) (param $b i64) (result i64)
      (if (global.get $fault) (then (return (i64.const 0))))
      (if (i64.eqz (local.get $b))
        (then (global.set $fault (i32.const 3)) (return (i64.const 0))))
      (if (result i64) (local.get $rem)
        (then (i64.rem_s (local.get $a) (local.get $b)))
        (else (call $checked (i64.div_s (local.get $a) (local.get $b))))))
    (func $alloc (param $n i32) (result i32) (local $p i32) (local.set $p (global.get $arena)) (global.set $arena (i32.and (i32.add (i32.add (global.get $arena) (local.get $n)) (i32.const 3)) (i32.const -4))) (if (i32.gt_u (global.get $arena) (i32.const 1048576)) (then (global.set $fault (i32.const 4)) (return (i32.const 0)))) (local.get $p))
    (func $str_eq (param $a i64) (param $b i64) (result i32) (local $i i32) (if (result i32) (i32.ne (call $len (local.get $a)) (call $len (local.get $b))) (then (i32.const 0)) (else (block $done (result i32) (loop $loop (if (i32.ge_u (local.get $i) (call $len (local.get $a))) (then (br $done (i32.const 1)))) (if (i32.ne (i32.load8_u (i32.add (call $ptr (local.get $a)) (local.get $i))) (i32.load8_u (i32.add (call $ptr (local.get $b)) (local.get $i)))) (then (br $done (i32.const 0)))) (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $loop)) (i32.const 1)))))
    (func $concat (param $a i64) (param $b i64) (result i64) (local $n i32) (local $p i32) (local.set $n (i32.add (call $len (local.get $a)) (call $len (local.get $b)))) (if (i32.gt_u (local.get $n) (i32.const 16384)) (then (global.set $fault (i32.const 4)) (return (i64.const 0)))) (local.set $p (call $alloc (local.get $n))) (call $mem_copy (local.get $p) (call $ptr (local.get $a)) (call $len (local.get $a))) (call $mem_copy (i32.add (local.get $p) (call $len (local.get $a))) (call $ptr (local.get $b)) (call $len (local.get $b))) (call $pack (local.get $p) (local.get $n)))
    (func $scalar_len (param $v i64) (result i32) (local $i i32) (local $n i32) (loop $loop (if (i32.lt_u (local.get $i) (call $len (local.get $v))) (then (if (i32.ne (i32.and (i32.load8_u (i32.add (call $ptr (local.get $v)) (local.get $i))) (i32.const 192)) (i32.const 128)) (then (local.set $n (i32.add (local.get $n) (i32.const 1))))) (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $loop)))) (local.get $n))
    (func $utf8_valid (param $p i32) (param $n i32) (result i32) (local $i i32) (local $j i32) (local $b i32) (local $c i32) (local $width i32) (local $min i32) (local $cp i32)
      (loop $outer
        (if (i32.ge_u (local.get $i) (local.get $n)) (then (return (i32.const 1))))
        (local.set $b (i32.load8_u (i32.add (local.get $p) (local.get $i))))
        (if (i32.lt_u (local.get $b) (i32.const 128)) (then (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $outer)))
        (local.set $width (i32.const 0))
        (if (i32.and (i32.ge_u (local.get $b) (i32.const 194)) (i32.le_u (local.get $b) (i32.const 223))) (then (local.set $width (i32.const 2)) (local.set $min (i32.const 128)) (local.set $cp (i32.and (local.get $b) (i32.const 31)))))
        (if (i32.and (i32.ge_u (local.get $b) (i32.const 224)) (i32.le_u (local.get $b) (i32.const 239))) (then (local.set $width (i32.const 3)) (local.set $min (i32.const 2048)) (local.set $cp (i32.and (local.get $b) (i32.const 15)))))
        (if (i32.and (i32.ge_u (local.get $b) (i32.const 240)) (i32.le_u (local.get $b) (i32.const 244))) (then (local.set $width (i32.const 4)) (local.set $min (i32.const 65536)) (local.set $cp (i32.and (local.get $b) (i32.const 7)))))
        (if (i32.eqz (local.get $width)) (then (return (i32.const 0))))
        (if (i32.gt_u (i32.add (local.get $i) (local.get $width)) (local.get $n)) (then (return (i32.const 0))))
        (local.set $j (i32.const 1))
        (loop $continuations
          (if (i32.lt_u (local.get $j) (local.get $width)) (then
            (local.set $c (i32.load8_u (i32.add (i32.add (local.get $p) (local.get $i)) (local.get $j))))
            (if (i32.ne (i32.and (local.get $c) (i32.const 192)) (i32.const 128)) (then (return (i32.const 0))))
            (local.set $cp (i32.or (i32.shl (local.get $cp) (i32.const 6)) (i32.and (local.get $c) (i32.const 63))))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $continuations))))
        (if (i32.or (i32.lt_u (local.get $cp) (local.get $min)) (i32.or (i32.gt_u (local.get $cp) (i32.const 1114111)) (i32.and (i32.ge_u (local.get $cp) (i32.const 55296)) (i32.le_u (local.get $cp) (i32.const 57343))))) (then (return (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (local.get $width)))
        (br $outer))
      (i32.const 1))
    (func $out_string (param $v i64) (result i32) (local $p i32) (local.set $p (global.get $out_cursor)) (if (i32.gt_u (i32.add (local.get $p) (call $len (local.get $v))) (global.get $out_end)) (then (global.set $fault (i32.const 4)) (return (i32.const 0)))) (call $mem_copy (local.get $p) (call $ptr (local.get $v)) (call $len (local.get $v))) (global.set $out_cursor (i32.and (i32.add (i32.add (local.get $p) (call $len (local.get $v))) (i32.const 3)) (i32.const -4))) (local.get $p))
    ${constantFunctions}
    ${functionTexts.join("\n")}
    (func (export "evaluate") (param $input i32) (param $input_len i32) (param $output i32) (param $output_cap i32) (result i32) (local $result i64) (local $copy i32)
      (global.set $fault (i32.const 0)) (global.set $fuel (i32.const 100000))
      (if (i32.or (i32.lt_u (local.get $input) (i32.const 64)) (i32.or (i32.lt_u (local.get $input_len) (i32.const ${layoutValueType(program.entryInput).size})) (i32.or (i32.gt_u (local.get $input_len) (i32.const 65536)) (i32.or (i32.lt_u (local.get $output) (i32.const 64)) (i32.or (i32.lt_u (local.get $output_cap) (i32.const ${outputLayout.size})) (i32.gt_u (local.get $output_cap) (i32.const 65536))))))) (then (return (i32.const 1))))
      (if (i32.or (i32.gt_u (local.get $input) (i32.const 1048576)) (i32.or (i32.gt_u (local.get $input_len) (i32.sub (i32.const 1048576) (local.get $input))) (i32.or (i32.gt_u (local.get $output) (i32.const 1048576)) (i32.gt_u (local.get $output_cap) (i32.sub (i32.const 1048576) (local.get $output)))))) (then (return (i32.const 1))))
      (if (i32.and (i32.lt_u (local.get $input) (i32.add (local.get $output) (local.get $output_cap))) (i32.lt_u (local.get $output) (i32.add (local.get $input) (local.get $input_len)))) (then (return (i32.const 1))))
      (if ${inputInvalid} (then (return (i32.const 1))))
      (global.set $out_cursor (i32.add (local.get $output) (i32.const ${outputLayout.size}))) (global.set $out_end (i32.add (local.get $output) (local.get $output_cap))) (global.set $arena (i32.and (i32.add (if (result i32) (i32.gt_u (i32.add (local.get $input) (local.get $input_len)) (i32.add (local.get $output) (local.get $output_cap))) (then (i32.add (local.get $input) (local.get $input_len))) (else (i32.add (local.get $output) (local.get $output_cap)))) (i32.const 3)) (i32.const -4))) (call $mem_zero (local.get $output) (local.get $output_cap))
      (local.set $result (call ${watName(entry.symbol)} (i64.extend_i32_u (local.get $input))))
      (if (global.get $fault) (then (return (global.get $fault)))) ${writers.join(" ")} (global.get $fault))
  )`;
  let module: binaryen.Module;
  try {
    module = binaryen.parseText(wat);
  } catch (error) {
    throw new Error(
      `INVALID_IR: failed to parse generated Wasm\n${wat
        .split("\n")
        .map((line, index) => `${index + 1}: ${line}`)
        .join("\n")}`,
      { cause: error },
    );
  }
  try {
    module.setFeatures(binaryen.Features.MutableGlobals);
    if (!module.validate())
      throw new Error("INVALID_IR: Binaryen validation failed");
    const bytes = new Uint8Array(module.emitBinary());
    if (!WebAssembly.validate(bytes))
      throw new Error("INVALID_IR: invalid Wasm");
    return {
      bytes,
      wat,
      contract: {
        abi: VALUE_ABI,
        memory: { initial: 16, maximum: 16 },
        inputType: program.entryInput,
        outputType: program.entryOutput,
        layoutHash: program.layoutHash,
        inputLimit: 65536,
        outputLimit: 65536,
      },
    };
  } finally {
    module.dispose();
  }
}
