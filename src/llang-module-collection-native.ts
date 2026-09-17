import type {
  CheckedCollectionFunction,
  CheckedCollectionProgram,
  CollectionBody,
  CollectionExpression,
  CollectionStatement,
  CollectionType,
  CollectionTypeUse,
} from "./llang-module-collection-ir";
import { canonicalCollectionType } from "./llang-module-collection-ir";
import { layoutCollectionType } from "./llang-collection-abi";

type Binding = { type: CollectionType; get: string; local?: string };
type Environment = Map<string, Binding>;

const align = (value: number, alignment: number) =>
  (value + alignment - 1) & -alignment;
const safe = (value: string) => value.replace(/[^A-Za-z0-9_$]/g, "_");
const i32 = (value: number) => `i32.const ${value | 0}`;
const seq = (...parts: (string | undefined)[]) =>
  parts.filter(Boolean).join("\n");

function collectTypes(type: CollectionType, output: CollectionType[]): void {
  output.push(type);
  if (type.kind === "list") collectTypes(type.element, output);
  else if (type.kind === "function") {
    type.parameters.forEach((item) => {
      collectTypes(item, output);
    });
    collectTypes(type.returns, output);
  } else if (type.kind === "record")
    type.fields.forEach((field) => {
      collectTypes(field.type, output);
    });
  else if (type.kind === "union")
    type.variants.forEach((variant) => {
      variant.fields.forEach((field) => {
        collectTypes(field.type, output);
      });
    });
}

function substitute(
  type: CollectionType,
  bindings: Map<string, CollectionType>,
): CollectionType {
  if (type.kind === "parameter") return bindings.get(type.name) ?? type;
  if (type.kind === "list")
    return { kind: "list", element: substitute(type.element, bindings) };
  if (type.kind === "function")
    return {
      kind: "function",
      parameters: type.parameters.map((item) => substitute(item, bindings)),
      returns: substitute(type.returns, bindings),
    };
  if (type.kind === "record")
    return {
      ...type,
      arguments: type.arguments.map((item) => substitute(item, bindings)),
      fields: type.fields.map((field) => ({
        ...field,
        type: substitute(field.type, bindings),
      })),
    };
  if (type.kind === "union")
    return {
      ...type,
      arguments: type.arguments.map((item) => substitute(item, bindings)),
      variants: type.variants.map((variant) => ({
        ...variant,
        fields: variant.fields.map((field) => ({
          ...field,
          type: substitute(field.type, bindings),
        })),
      })),
    };
  return type;
}

class NativeCompiler {
  private readonly functions = new Map<string, CheckedCollectionFunction>();
  private readonly names = new Map<string, string>();
  private readonly knownTypes: CollectionType[] = [];
  private readonly lambdaIds = new Map<CollectionExpression, number>();
  private readonly lambdaFunctions: string[] = [];
  private readonly dispatchArities = new Set<number>();
  private readonly copyNames = new Map<string, string>();
  private readonly copyFunctions: string[] = [];
  private nextLambda = 1;
  private nextTemporary = 0;

  constructor(private readonly program: CheckedCollectionProgram) {
    program.functions.forEach((fn, index) => {
      this.functions.set(fn.symbol, fn);
      this.names.set(fn.symbol, `$f${index}_${safe(fn.name)}`);
      fn.parameterTypes.forEach((type) => {
        collectTypes(type, this.knownTypes);
      });
      collectTypes(fn.returnType, this.knownTypes);
    });
    collectTypes(program.entryInput, this.knownTypes);
    collectTypes(program.entryOutput, this.knownTypes);
  }

  compile(): string {
    const compiledFunctions = this.program.functions.map((fn) =>
      this.emitFunction(fn),
    );
    const entry = this.names.get(this.program.entry);
    if (!entry) throw new Error("INVALID_IR: entry function missing");
    const outputLayout = layoutCollectionType(this.program.entryOutput);
    const materialize =
      this.program.entryOutput.kind === "boolean" ||
      this.program.entryOutput.kind === "i32"
        ? "local.get $output local.get $result i32.store"
        : `local.get $result local.get $output call ${this.ensureCopyFunction(this.program.entryOutput)}`;
    const evaluate = `(func (export "evaluate")
      (param $input i32) (param $inputLength i32) (param $output i32) (param $capacity i32)
      (result i32) (local $result i32)
      global.get $busy
      if i32.const 5 call $fail end
      i32.const 1 global.set $busy
      i32.const 0 global.set $fault
      i32.const 1000000 global.set $fuel
      i32.const 0 global.set $depth
      local.get $output
      i32.const ${align(outputLayout.size, 4)}
      i32.add global.set $heap
      local.get $output local.get $capacity i32.add global.set $heapEnd
      local.get $input call ${entry} local.set $result
      ${materialize}
      i32.const 0 global.set $busy
      global.get $heap local.get $output i32.sub)
    (func (export "fault_code") (result i32) global.get $fault)`;
    const dispatchers = [...this.dispatchArities]
      .sort((a, b) => a - b)
      .map((arity) => this.emitDispatcher(arity));
    return `(module
      (memory (export "memory") 128 128)
      (global $heap (mut i32) (i32.const 0))
      (global $heapEnd (mut i32) (i32.const 0))
      (global $fuel (mut i32) (i32.const 0))
      (global $depth (mut i32) (i32.const 0))
      (global $fault (mut i32) (i32.const 0))
      (global $busy (mut i32) (i32.const 0))
      ${this.helpers()}
      ${compiledFunctions.join("\n")}
      ${this.lambdaFunctions.join("\n")}
      ${dispatchers.join("\n")}
      ${this.copyFunctions.join("\n")}
      ${evaluate})`;
  }

  private helpers(): string {
    return `(func $fail (param $code i32)
      local.get $code global.set $fault unreachable)
    (func $charge
      global.get $fuel i32.const 1 i32.sub global.set $fuel
      global.get $fuel i32.const 0 i32.lt_s if i32.const 4 call $fail end)
    (func $enter
      call $charge
      global.get $depth i32.const 1 i32.add global.set $depth
      global.get $depth i32.const 64 i32.gt_u if i32.const 4 call $fail end)
    (func $leave global.get $depth i32.const 1 i32.sub global.set $depth)
    (func $alloc (param $size i32) (param $alignment i32) (result i32)
      (local $start i32)
      global.get $heap local.get $alignment i32.const 1 i32.sub i32.add
      local.get $alignment i32.const 1 i32.sub i32.const -1 i32.xor i32.and local.tee $start
      local.get $size i32.add global.get $heapEnd i32.gt_u
      if i32.const 4 call $fail end
      local.get $start local.get $size i32.add global.set $heap
      local.get $start)
    (func $add (param $a i32) (param $b i32) (result i32) (local $n i64)
      local.get $a i64.extend_i32_s local.get $b i64.extend_i32_s i64.add local.tee $n
      i64.const -2147483648 i64.lt_s
      local.get $n i64.const 2147483647 i64.gt_s i32.or
      if i32.const 3 call $fail end local.get $n i32.wrap_i64)
    (func $sub (param $a i32) (param $b i32) (result i32) (local $n i64)
      local.get $a i64.extend_i32_s local.get $b i64.extend_i32_s i64.sub local.tee $n
      i64.const -2147483648 i64.lt_s
      local.get $n i64.const 2147483647 i64.gt_s i32.or
      if i32.const 3 call $fail end local.get $n i32.wrap_i64)
    (func $mul (param $a i32) (param $b i32) (result i32) (local $n i64)
      local.get $a i64.extend_i32_s local.get $b i64.extend_i32_s i64.mul local.tee $n
      i64.const -2147483648 i64.lt_s
      local.get $n i64.const 2147483647 i64.gt_s i32.or
      if i32.const 3 call $fail end local.get $n i32.wrap_i64)
    (func $div (param $a i32) (param $b i32) (result i32)
      local.get $b i32.eqz if i32.const 2 call $fail end
      local.get $a i32.const -2147483648 i32.eq
      local.get $b i32.const -1 i32.eq i32.and
      if i32.const 3 call $fail end local.get $a local.get $b i32.div_s)
    (func $rem (param $a i32) (param $b i32) (result i32)
      local.get $b i32.eqz if i32.const 2 call $fail end
      local.get $a local.get $b i32.rem_s)
    (func $copyBytes (param $from i32) (param $to i32) (param $count i32)
      (local $i i32)
      block $done loop $loop
        local.get $i local.get $count i32.ge_u br_if $done
        local.get $to local.get $i i32.add
        local.get $from local.get $i i32.add i32.load8_u i32.store8
        local.get $i i32.const 1 i32.add local.set $i br $loop
      end end)`;
  }

  private fresh(prefix: string): string {
    return `$${prefix}${this.nextTemporary++}`;
  }

  private resolveUse(
    use: CollectionTypeUse,
    fn: CheckedCollectionFunction,
    bindings: Map<string, CollectionType>,
  ): CollectionType {
    if (typeof use === "string") return { kind: use };
    if ("list" in use)
      return { kind: "list", element: this.resolveUse(use.list, fn, bindings) };
    if ("function" in use)
      return {
        kind: "function",
        parameters: use.function.parameters.map((item) =>
          this.resolveUse(item, fn, bindings),
        ),
        returns: this.resolveUse(use.function.returns, fn, bindings),
      };
    const parameter = bindings.get(use.ref);
    if (parameter) return parameter;
    const symbol = fn.typeBindings[use.ref] ?? `${fn.moduleId}#${use.ref}`;
    const arguments_ = (use.arguments ?? []).map((item) =>
      this.resolveUse(item, fn, bindings),
    );
    const found = this.knownTypes.find(
      (type) =>
        (type.kind === "record" || type.kind === "union") &&
        type.symbol === symbol &&
        JSON.stringify(type.arguments) === JSON.stringify(arguments_),
    );
    if (!found) throw new Error(`INVALID_IR: unresolved type ${use.ref}`);
    return found;
  }

  private expressionType(
    expr: CollectionExpression,
    fn: CheckedCollectionFunction,
    env: Environment,
    typeBindings = new Map<string, CollectionType>(),
  ): CollectionType {
    if (expr.kind === "literal") return { kind: expr.type };
    if (expr.kind === "param" || expr.kind === "local") {
      const binding = env.get(expr.name);
      if (!binding) throw new Error(`INVALID_IR: unknown binding ${expr.name}`);
      return binding.type;
    }
    if (expr.kind === "list")
      return {
        kind: "list",
        element: this.resolveUse(expr.elementType, fn, typeBindings),
      };
    if (expr.kind === "field") {
      const base = this.expressionType(expr.base, fn, env, typeBindings);
      if (base.kind !== "record") throw new Error("INVALID_IR: field base");
      const field = base.fields.find((item) => item.name === expr.name);
      if (!field) throw new Error(`INVALID_IR: unknown field ${expr.name}`);
      return field.type;
    }
    if (expr.kind === "unary")
      return expr.op === "not" ? { kind: "boolean" } : { kind: "i32" };
    if (expr.kind === "binary")
      return ["<", "<=", ">", ">=", "===", "!==", "&&", "||"].includes(expr.op)
        ? { kind: "boolean" }
        : { kind: "i32" };
    if (expr.kind === "if")
      return this.expressionType(expr.whenTrue, fn, env, typeBindings);
    if (expr.kind === "lambda")
      return {
        kind: "function",
        parameters: expr.parameters.map((item) =>
          this.resolveUse(item.type, fn, typeBindings),
        ),
        returns: this.resolveUse(expr.returns, fn, typeBindings),
      };
    if (expr.kind === "call") {
      const target = this.functions.get(fn.callees[expr.callee] ?? "");
      if (!target) throw new Error(`INVALID_IR: unknown call ${expr.callee}`);
      const callBindings = new Map<string, CollectionType>();
      target.typeParameters.forEach((name, index) => {
        const use = expr.typeArguments[index];
        if (use) callBindings.set(name, this.resolveUse(use, fn, typeBindings));
      });
      return substitute(target.returnType, callBindings);
    }
    if (expr.kind === "invoke") {
      const callee = this.expressionType(expr.callee, fn, env, typeBindings);
      if (callee.kind !== "function") throw new Error("INVALID_IR: invoke");
      return callee.returns;
    }
    if (expr.kind === "record" || expr.kind === "variant")
      return this.resolveUse(
        { ref: expr.type, arguments: expr.typeArguments },
        fn,
        typeBindings,
      );
    if (expr.kind !== "intrinsic") throw new Error("INVALID_IR: expression");
    if (expr.name === "concat") return { kind: "string" };
    if (expr.name === "scalarLength" || expr.name === "length")
      return { kind: "i32" };
    const input = this.expressionType(
      expr.arguments[0]!,
      fn,
      env,
      typeBindings,
    );
    if (input.kind !== "list") throw new Error("INVALID_IR: List intrinsic");
    if (expr.name === "at") return input.element;
    if (["set", "append", "filter", "stableSort"].includes(expr.name))
      return input;
    if (expr.name === "map") {
      const callback = this.expressionType(
        expr.arguments[1]!,
        fn,
        env,
        typeBindings,
      );
      if (callback.kind !== "function") throw new Error("INVALID_IR: map");
      return { kind: "list", element: callback.returns };
    }
    return this.expressionType(expr.arguments[1]!, fn, env, typeBindings);
  }

  private emitFunction(fn: CheckedCollectionFunction): string {
    const env: Environment = new Map();
    fn.parameters.forEach((parameter, index) => {
      const name = `$p${index}_${safe(parameter.name)}`;
      env.set(parameter.name, {
        type: fn.parameterTypes[index]!,
        get: `local.get ${name}`,
        local: name,
      });
    });
    const locals: string[] = [],
      result = this.fresh("result");
    locals.push(result);
    const context = {
      fn,
      env,
      locals,
      typeBindings: new Map<string, CollectionType>(),
    };
    const body = this.emitBody(fn.body, context);
    return `(func ${this.names.get(fn.symbol)} ${fn.parameters
      .map(
        (parameter, index) => `(param $p${index}_${safe(parameter.name)} i32)`,
      )
      .join(" ")} (result i32)
      ${locals.map((name) => `(local ${name} i32)`).join(" ")}
      call $enter
      block $return
        ${body.code}
        ${body.value ?? "i32.const 0"} local.set ${result}
      end
      call $leave local.get ${result})`;
  }

  private emitBody(
    body: CollectionBody,
    context: {
      fn: CheckedCollectionFunction;
      env: Environment;
      locals: string[];
      typeBindings: Map<string, CollectionType>;
    },
  ): { code: string; value?: string } {
    const code = body.statements
      .map((statement) => this.emitStatement(statement, context))
      .join("\n");
    return body.result
      ? { code, value: this.emitExpression(body.result, context) }
      : { code };
  }

  private emitStatement(
    statement: CollectionStatement,
    context: {
      fn: CheckedCollectionFunction;
      env: Environment;
      locals: string[];
      typeBindings: Map<string, CollectionType>;
    },
  ): string {
    const { fn, env, locals, typeBindings } = context;
    if (statement.kind === "const" || statement.kind === "let") {
      const local = this.fresh(`v_${safe(statement.name)}_`);
      locals.push(local);
      const type = this.resolveUse(statement.type, fn, typeBindings);
      const value = this.emitExpression(statement.value, context);
      env.set(statement.name, { type, get: `local.get ${local}`, local });
      return seq("call $charge", value, `local.set ${local}`);
    }
    if (statement.kind === "assign") {
      const binding = env.get(statement.name);
      if (!binding?.local) throw new Error("INVALID_IR: assignment target");
      return seq(
        "call $charge",
        this.emitExpression(statement.value, context),
        `local.set ${binding.local}`,
      );
    }
    if (statement.kind === "return")
      return seq(
        "call $charge",
        this.emitExpression(statement.value, context),
        `local.set ${locals[0] ?? "$result"}`,
        "br $return",
      );
    if (statement.kind === "break") return "br $break";
    if (statement.kind === "continue") return "br $continue";
    if (statement.kind === "if") {
      const before = new Map(env);
      const yes = statement.whenTrue
        .map((item) =>
          this.emitStatement(item, { ...context, env: new Map(before) }),
        )
        .join("\n");
      const no = statement.whenFalse
        .map((item) =>
          this.emitStatement(item, { ...context, env: new Map(before) }),
        )
        .join("\n");
      return `${this.emitExpression(statement.condition, context)} if ${yes} else ${no} end`;
    }
    if (statement.kind === "while") {
      const nested = { ...context, env: new Map(env) };
      const body = statement.body
        .map((item) => this.emitStatement(item, nested))
        .join("\n");
      return `block $break loop $continue call $charge ${this.emitExpression(
        statement.condition,
        context,
      )} i32.eqz br_if $break ${body} br $continue end end`;
    }
    if (statement.kind === "forEach") {
      const list = this.fresh("foreach_list"),
        index = this.fresh("foreach_index"),
        item = this.fresh("foreach_item");
      locals.push(list, index, item);
      const listType = this.expressionType(
        statement.value,
        fn,
        env,
        typeBindings,
      );
      if (listType.kind !== "list") throw new Error("INVALID_IR: forEach List");
      const layout = layoutCollectionType(listType.element),
        stride = align(layout.size, layout.align),
        nestedEnv = new Map(env);
      nestedEnv.set(statement.name, {
        type: listType.element,
        get: `local.get ${item}`,
        local: item,
      });
      const body = statement.body
        .map((child) =>
          this.emitStatement(child, { ...context, env: nestedEnv }),
        )
        .join("\n");
      const load = this.loadValue(
        listType.element,
        `local.get ${list} i32.load local.get ${index} i32.const ${stride} i32.mul i32.add`,
      );
      return `${this.emitExpression(statement.value, context)} local.set ${list}
        i32.const 0 local.set ${index}
        block $break loop $continue call $charge
          local.get ${index} local.get ${list} i32.load offset=4 i32.ge_u br_if $break
          ${load} local.set ${item}
          ${body}
          local.get ${index} i32.const 1 i32.add local.set ${index} br $continue
        end end`;
    }
    if (statement.kind === "match") {
      const value = this.fresh("match");
      locals.push(value);
      const type = this.expressionType(statement.value, fn, env, typeBindings);
      if (type.kind !== "union") throw new Error("INVALID_IR: match union");
      let chain = "i32.const 5 call $fail";
      for (let index = statement.cases.length - 1; index >= 0; index--) {
        const item = statement.cases[index]!;
        const tag = type.variants.findIndex(
          (variant) => variant.tag === item.tag,
        );
        const body = item.body
          .map((child) =>
            this.emitStatement(child, { ...context, env: new Map(env) }),
          )
          .join("\n");
        chain = `local.get ${value} i32.load i32.const ${tag} i32.eq if ${body} else ${chain} end`;
      }
      return `${this.emitExpression(statement.value, context)} local.set ${value} ${chain}`;
    }
    throw new Error("INVALID_IR: unsupported statement");
  }

  private emitExpression(
    expr: CollectionExpression,
    context: {
      fn: CheckedCollectionFunction;
      env: Environment;
      locals: string[];
      typeBindings: Map<string, CollectionType>;
    },
  ): string {
    const { fn, env, locals, typeBindings } = context;
    if (expr.kind === "literal") {
      if (expr.type === "string") {
        const bytes = new TextEncoder().encode(String(expr.value));
        const pointer = this.fresh("string");
        locals.push(pointer);
        const stores = [...bytes]
          .map(
            (byte, index) =>
              `local.get ${pointer} i32.load i32.const ${index} i32.add i32.const ${byte} i32.store8`,
          )
          .join("\n");
        return `i32.const 8 i32.const 4 call $alloc local.tee ${pointer}
          i32.const ${bytes.length} i32.const 1 call $alloc i32.store
          local.get ${pointer} i32.const ${bytes.length} i32.store offset=4
          ${stores} local.get ${pointer}`;
      }
      return i32(
        expr.value === true ? 1 : expr.value === false ? 0 : Number(expr.value),
      );
    }
    if (expr.kind === "param" || expr.kind === "local") {
      const binding = env.get(expr.name);
      if (!binding) throw new Error(`INVALID_IR: unknown binding ${expr.name}`);
      return binding.get;
    }
    if (expr.kind === "field") {
      const baseType = this.expressionType(expr.base, fn, env, typeBindings);
      if (baseType.kind !== "record") throw new Error("INVALID_IR: field");
      const layout = layoutCollectionType(baseType),
        field = layout.fields?.find((item) => item.name === expr.name);
      if (!field) throw new Error("INVALID_IR: field layout");
      return this.loadValue(
        field.type,
        `${this.emitExpression(expr.base, context)} i32.const ${field.offset} i32.add`,
      );
    }
    if (expr.kind === "unary")
      return expr.op === "not"
        ? `${this.emitExpression(expr.operand, context)} i32.eqz`
        : `i32.const 0 ${this.emitExpression(expr.operand, context)} call $sub`;
    if (expr.kind === "binary") {
      if (expr.op === "&&")
        return `${this.emitExpression(expr.left, context)} if (result i32) ${this.emitExpression(expr.right, context)} else i32.const 0 end`;
      if (expr.op === "||")
        return `${this.emitExpression(expr.left, context)} if (result i32) i32.const 1 else ${this.emitExpression(expr.right, context)} end`;
      const a = this.emitExpression(expr.left, context),
        b = this.emitExpression(expr.right, context),
        op: Record<string, string> = {
          "+": "call $add",
          "-": "call $sub",
          "*": "call $mul",
          "/": "call $div",
          "%": "call $rem",
          "<": "i32.lt_s",
          "<=": "i32.le_s",
          ">": "i32.gt_s",
          ">=": "i32.ge_s",
          "===": "i32.eq",
          "!==": "i32.ne",
        };
      const instruction = op[expr.op];
      if (!instruction) throw new Error(`INVALID_IR: operator ${expr.op}`);
      return `${a} ${b} ${instruction}`;
    }
    if (expr.kind === "if")
      return `${this.emitExpression(expr.condition, context)} if (result i32) ${this.emitExpression(expr.whenTrue, context)} else ${this.emitExpression(expr.whenFalse, context)} end`;
    if (expr.kind === "list") {
      const type = this.expressionType(expr, fn, env, typeBindings);
      if (type.kind !== "list") throw new Error("INVALID_IR: list");
      return this.makeList(
        type.element,
        expr.elements.map((item) => this.emitExpression(item, context)),
        locals,
      );
    }
    if (expr.kind === "record" || expr.kind === "variant") {
      const type = this.expressionType(expr, fn, env, typeBindings);
      if (type.kind !== "record" && type.kind !== "union")
        throw new Error("INVALID_IR: aggregate");
      const layout = layoutCollectionType(type),
        pointer = this.fresh("aggregate");
      locals.push(pointer);
      const variant =
        type.kind === "union" && expr.kind === "variant"
          ? layout.variants?.find((item) => item.tag === expr.tag)
          : undefined;
      const fields = type.kind === "record" ? layout.fields : variant?.fields;
      if (!fields) throw new Error("INVALID_IR: aggregate layout");
      const writes = expr.fields
        .map((field) => {
          const target = fields.find((item) => item.name === field.name);
          if (!target) throw new Error("INVALID_IR: aggregate field");
          return this.storeValue(
            target.type,
            this.emitExpression(field.value, context),
            `local.get ${pointer} i32.const ${target.offset} i32.add`,
          );
        })
        .join("\n");
      return `i32.const ${layout.size} i32.const ${layout.align} call $alloc local.tee ${pointer}
        ${type.kind === "union" ? `i32.const ${variant?.index ?? -1} i32.store` : "drop"}
        ${writes} local.get ${pointer}`;
    }
    if (expr.kind === "lambda") return this.emitLambda(expr, context);
    if (expr.kind === "call") {
      const target = this.functions.get(fn.callees[expr.callee] ?? ""),
        name = target && this.names.get(target.symbol);
      if (!target || !name) throw new Error(`INVALID_IR: call ${expr.callee}`);
      return `${expr.arguments.map((item) => this.emitExpression(item, context)).join(" ")} call ${name}`;
    }
    if (expr.kind === "invoke") {
      const type = this.expressionType(expr.callee, fn, env, typeBindings);
      if (type.kind !== "function") throw new Error("INVALID_IR: invoke");
      this.dispatchArities.add(expr.arguments.length);
      return `${this.emitExpression(expr.callee, context)} ${expr.arguments.map((item) => this.emitExpression(item, context)).join(" ")} call $dispatch${expr.arguments.length}`;
    }
    if (expr.kind !== "intrinsic") throw new Error("INVALID_IR: expression");
    return this.emitIntrinsic(expr, context);
  }

  private emitLambda(
    expr: Extract<CollectionExpression, { kind: "lambda" }>,
    context: {
      fn: CheckedCollectionFunction;
      env: Environment;
      locals: string[];
      typeBindings: Map<string, CollectionType>;
    },
  ): string {
    let id = this.lambdaIds.get(expr);
    if (!id) {
      id = this.nextLambda++;
      this.lambdaIds.set(expr, id);
      const own = new Set(expr.parameters.map((parameter) => parameter.name)),
        refs = new Set<string>();
      const scan = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const item = value as Record<string, unknown>;
        if (
          (item.kind === "local" || item.kind === "param") &&
          typeof item.name === "string" &&
          !own.has(item.name) &&
          context.env.has(item.name)
        )
          refs.add(item.name);
        Object.values(item).forEach(scan);
      };
      scan(expr.body);
      const captures = [...refs].sort(),
        lambdaEnv: Environment = new Map();
      captures.forEach((name, index) => {
        const binding = context.env.get(name)!;
        lambdaEnv.set(name, {
          type: binding.type,
          get: `local.get $env i32.load offset=${8 + index * 4}`,
        });
      });
      const parameterTypes = expr.parameters.map((parameter) =>
        this.resolveUse(parameter.type, context.fn, context.typeBindings),
      );
      expr.parameters.forEach((parameter, index) => {
        lambdaEnv.set(parameter.name, {
          type: parameterTypes[index]!,
          get: `local.get $p${index}`,
          local: `$p${index}`,
        });
      });
      const locals: string[] = [],
        result = this.fresh("lambdaResult");
      locals.push(result);
      const nested = {
          fn: context.fn,
          env: lambdaEnv,
          locals,
          typeBindings: context.typeBindings,
        },
        body = this.emitBody(expr.body, nested);
      this.lambdaFunctions.push(`(func $lambda${id} (param $env i32) ${expr.parameters
        .map((_parameter, index) => `(param $p${index} i32)`)
        .join(" ")} (result i32)
        ${locals.map((name) => `(local ${name} i32)`).join(" ")}
        call $enter block $return ${body.code} ${body.value ?? "i32.const 0"} local.set ${result} end
        call $leave local.get ${result})`);
      const pointer = this.fresh("closure");
      context.locals.push(pointer);
      const stores = captures
        .map((name, index) => {
          const binding = context.env.get(name)!;
          return `local.get ${pointer} ${binding.get} i32.store offset=${8 + index * 4}`;
        })
        .join("\n");
      return `i32.const ${8 + captures.length * 4} i32.const 4 call $alloc local.tee ${pointer}
        i32.const ${id} i32.store local.get ${pointer} i32.const ${captures.length} i32.store offset=4
        ${stores} local.get ${pointer}`;
    }
    throw new Error("INVALID_IR: reused lambda node");
  }

  private emitDispatcher(arity: number): string {
    const parameters = Array.from(
        { length: arity },
        (_, index) => `$p${index}`,
      ),
      candidates = [...this.lambdaIds.entries()].filter(
        ([expression]) =>
          expression.kind === "lambda" &&
          expression.parameters.length === arity,
      );
    let chain = "i32.const 5 call $fail i32.const 0";
    for (let index = candidates.length - 1; index >= 0; index--) {
      const [, id] = candidates[index]!;
      chain = `local.get $closure i32.load i32.const ${id} i32.eq if (result i32) local.get $closure ${parameters.map((name) => `local.get ${name}`).join(" ")} call $lambda${id} else ${chain} end`;
    }
    return `(func $dispatch${arity} (param $closure i32) ${parameters
      .map((name) => `(param ${name} i32)`)
      .join(" ")} (result i32) ${chain})`;
  }

  private emitIntrinsic(
    expr: Extract<CollectionExpression, { kind: "intrinsic" }>,
    context: {
      fn: CheckedCollectionFunction;
      env: Environment;
      locals: string[];
      typeBindings: Map<string, CollectionType>;
    },
  ): string {
    const inputType = this.expressionType(
      expr.arguments[0]!,
      context.fn,
      context.env,
      context.typeBindings,
    );
    if (expr.name === "length")
      return `${this.emitExpression(expr.arguments[0]!, context)} i32.load offset=4`;
    if (expr.name === "scalarLength")
      return this.emitScalarLength(
        this.emitExpression(expr.arguments[0]!, context),
        context.locals,
      );
    if (expr.name === "concat")
      return this.emitConcat(
        this.emitExpression(expr.arguments[0]!, context),
        this.emitExpression(expr.arguments[1]!, context),
        context.locals,
      );
    if (inputType.kind !== "list")
      throw new Error("INVALID_IR: List intrinsic");
    const list = this.fresh("list"),
      index = this.fresh("index"),
      output = this.fresh("listOutput"),
      count = this.fresh("count"),
      layout = layoutCollectionType(inputType.element),
      stride = align(layout.size, layout.align);
    context.locals.push(list, index, output, count);
    const input = this.emitExpression(expr.arguments[0]!, context),
      address = `local.get ${list} i32.load local.get ${index} i32.const ${stride} i32.mul i32.add`,
      item = this.loadValue(inputType.element, address);
    if (expr.name === "at") {
      const wanted = this.fresh("wanted");
      context.locals.push(wanted);
      return `${input} local.set ${list} ${this.emitExpression(expr.arguments[1]!, context)} local.tee ${wanted}
        i32.const 0 i32.lt_s local.get ${wanted} local.get ${list} i32.load offset=4 i32.ge_u i32.or
        if i32.const 1 call $fail end
        ${this.loadValue(inputType.element, `local.get ${list} i32.load local.get ${wanted} i32.const ${stride} i32.mul i32.add`)}`;
    }
    if (expr.name === "set" || expr.name === "append") {
      const wanted = this.fresh("wanted"),
        value = this.fresh("itemValue");
      context.locals.push(wanted, value);
      const isAppend = expr.name === "append";
      return `${input} local.set ${list}
        ${isAppend ? `local.get ${list} i32.load offset=4` : this.emitExpression(expr.arguments[1]!, context)} local.set ${wanted}
        ${this.emitExpression(expr.arguments[isAppend ? 1 : 2]!, context)} local.set ${value}
        ${isAppend ? `local.get ${wanted} i32.const 4096 i32.ge_u if i32.const 4 call $fail end` : `local.get ${wanted} i32.const 0 i32.lt_s local.get ${wanted} local.get ${list} i32.load offset=4 i32.ge_u i32.or if i32.const 1 call $fail end`}
        i32.const 8 i32.const 4 call $alloc local.tee ${output}
        i32.const ${stride} local.get ${list} i32.load offset=4 ${isAppend ? "i32.const 1 i32.add" : ""} i32.mul i32.const ${layout.align} call $alloc i32.store
        local.get ${output} local.get ${list} i32.load offset=4 ${isAppend ? "i32.const 1 i32.add" : ""} i32.store offset=4
        i32.const 0 local.set ${index}
        block $copyDone loop $copyLoop local.get ${index} local.get ${list} i32.load offset=4 i32.ge_u br_if $copyDone
          ${this.copyShallow(inputType.element, address, `local.get ${output} i32.load local.get ${index} i32.const ${stride} i32.mul i32.add`)}
          local.get ${index} i32.const 1 i32.add local.set ${index} br $copyLoop end end
        ${this.storeValue(inputType.element, `local.get ${value}`, `local.get ${output} i32.load local.get ${wanted} i32.const ${stride} i32.mul i32.add`)}
        local.get ${output}`;
    }
    const callbackIndex = expr.name === "fold" ? 2 : 1,
      callback = this.fresh("callback");
    context.locals.push(callback);
    this.dispatchArities.add(
      expr.name === "fold" || expr.name === "stableSort" ? 2 : 1,
    );
    if (expr.name === "fold") {
      const accumulator = this.fresh("accumulator");
      context.locals.push(accumulator);
      return `${input} local.set ${list}
        ${this.emitExpression(expr.arguments[1]!, context)} local.set ${accumulator}
        ${this.emitExpression(expr.arguments[callbackIndex]!, context)} local.set ${callback}
        i32.const 0 local.set ${index}
        block $foldDone loop $foldLoop local.get ${index} local.get ${list} i32.load offset=4 i32.ge_u br_if $foldDone
          local.get ${callback} local.get ${accumulator} ${item} call $dispatch2 local.set ${accumulator}
          local.get ${index} i32.const 1 i32.add local.set ${index} br $foldLoop end end
        local.get ${accumulator}`;
    }
    if (expr.name === "map" || expr.name === "filter") {
      const resultType = this.expressionType(
        expr,
        context.fn,
        context.env,
        context.typeBindings,
      );
      if (resultType.kind !== "list") throw new Error("INVALID_IR: map/filter");
      const resultLayout = layoutCollectionType(resultType.element),
        resultStride = align(resultLayout.size, resultLayout.align),
        mapped = this.fresh("mapped");
      context.locals.push(mapped);
      return `${input} local.set ${list}
        ${this.emitExpression(expr.arguments[callbackIndex]!, context)} local.set ${callback}
        i32.const 8 i32.const 4 call $alloc local.tee ${output}
        i32.const ${resultStride} local.get ${list} i32.load offset=4 i32.mul i32.const ${resultLayout.align} call $alloc i32.store
        i32.const 0 local.set ${count} i32.const 0 local.set ${index}
        block $transformDone loop $transformLoop local.get ${index} local.get ${list} i32.load offset=4 i32.ge_u br_if $transformDone
          ${expr.name === "map" ? `local.get ${callback} ${item} call $dispatch1 local.set ${mapped} ${this.storeValue(resultType.element, `local.get ${mapped}`, `local.get ${output} i32.load local.get ${count} i32.const ${resultStride} i32.mul i32.add`)} local.get ${count} i32.const 1 i32.add local.set ${count}` : `local.get ${callback} ${item} call $dispatch1 if ${this.copyShallow(inputType.element, address, `local.get ${output} i32.load local.get ${count} i32.const ${resultStride} i32.mul i32.add`)} local.get ${count} i32.const 1 i32.add local.set ${count} end`}
          local.get ${index} i32.const 1 i32.add local.set ${index} br $transformLoop end end
        local.get ${output} local.get ${count} i32.store offset=4 local.get ${output}`;
    }
    if (expr.name === "stableSort") {
      const j = this.fresh("sortJ"),
        key = this.fresh("sortKey"),
        previous = this.fresh("sortPrevious");
      context.locals.push(j, key, previous);
      return `${input} local.set ${list}
        ${this.emitExpression(expr.arguments[1]!, context)} local.set ${callback}
        i32.const 8 i32.const 4 call $alloc local.tee ${output}
        i32.const ${stride} local.get ${list} i32.load offset=4 i32.mul i32.const ${layout.align} call $alloc i32.store
        local.get ${output} local.get ${list} i32.load offset=4 i32.store offset=4
        i32.const 0 local.set ${index}
        block $sortCopyDone loop $sortCopyLoop local.get ${index} local.get ${list} i32.load offset=4 i32.ge_u br_if $sortCopyDone
          ${this.copyShallow(inputType.element, address, `local.get ${output} i32.load local.get ${index} i32.const ${stride} i32.mul i32.add`)}
          local.get ${index} i32.const 1 i32.add local.set ${index} br $sortCopyLoop end end
        i32.const 1 local.set ${index}
        block $sortDone loop $sortOuter local.get ${index} local.get ${output} i32.load offset=4 i32.ge_u br_if $sortDone
          ${this.loadValue(inputType.element, `local.get ${output} i32.load local.get ${index} i32.const ${stride} i32.mul i32.add`)} local.set ${key}
          local.get ${index} local.set ${j}
          block $insertDone loop $insert
            local.get ${j} i32.eqz br_if $insertDone
            ${this.loadValue(inputType.element, `local.get ${output} i32.load local.get ${j} i32.const 1 i32.sub i32.const ${stride} i32.mul i32.add`)} local.set ${previous}
            local.get ${callback} local.get ${previous} local.get ${key} call $dispatch2 i32.const 0 i32.le_s br_if $insertDone
            ${this.copyShallow(inputType.element, `local.get ${output} i32.load local.get ${j} i32.const 1 i32.sub i32.const ${stride} i32.mul i32.add`, `local.get ${output} i32.load local.get ${j} i32.const ${stride} i32.mul i32.add`)}
            local.get ${j} i32.const 1 i32.sub local.set ${j} br $insert
          end end
          ${this.storeValue(inputType.element, `local.get ${key}`, `local.get ${output} i32.load local.get ${j} i32.const ${stride} i32.mul i32.add`)}
          local.get ${index} i32.const 1 i32.add local.set ${index} br $sortOuter
        end end local.get ${output}`;
    }
    throw new Error(`INVALID_IR: intrinsic ${expr.name}`);
  }

  private makeList(
    element: CollectionType,
    values: string[],
    locals: string[],
  ): string {
    const layout = layoutCollectionType(element),
      stride = align(layout.size, layout.align),
      pointer = this.fresh("literalList");
    locals.push(pointer);
    return `i32.const 8 i32.const 4 call $alloc local.tee ${pointer}
      i32.const ${stride * values.length} i32.const ${layout.align} call $alloc i32.store
      local.get ${pointer} i32.const ${values.length} i32.store offset=4
      ${values.map((value, index) => this.storeValue(element, value, `local.get ${pointer} i32.load i32.const ${index * stride} i32.add`)).join("\n")}
      local.get ${pointer}`;
  }

  private loadValue(type: CollectionType, address: string): string {
    return type.kind === "boolean" || type.kind === "i32"
      ? `${address} i32.load`
      : address;
  }

  private storeValue(
    type: CollectionType,
    value: string,
    address: string,
  ): string {
    if (type.kind === "boolean" || type.kind === "i32")
      return `${address} ${value} i32.store`;
    const size = layoutCollectionType(type).size;
    return `${value} ${address} i32.const ${size} call $copyBytes`;
  }

  private copyShallow(type: CollectionType, from: string, to: string): string {
    const size = layoutCollectionType(type).size;
    return `${from} ${to} i32.const ${size} call $copyBytes`;
  }

  private ensureCopyFunction(type: CollectionType): string {
    const key = JSON.stringify(canonicalCollectionType(type)),
      existing = this.copyNames.get(key);
    if (existing) return existing;
    const name = `$copy${this.copyNames.size}`;
    this.copyNames.set(key, name);
    let body: string;
    if (type.kind === "boolean" || type.kind === "i32")
      body = "local.get $to local.get $from i32.load i32.store";
    else if (type.kind === "string")
      body = `local.get $to local.get $from i32.load offset=4 local.tee $count i32.store offset=4
        local.get $count i32.eqz
        if local.get $to i32.const 0 i32.store
        else
          local.get $to local.get $count i32.const 1 call $alloc local.tee $target i32.store
          local.get $from i32.load local.get $target local.get $count call $copyBytes
        end`;
    else if (type.kind === "list") {
      const item = layoutCollectionType(type.element),
        stride = align(item.size, item.align),
        copyItem = this.ensureCopyFunction(type.element);
      body = `local.get $from i32.load offset=4 local.tee $count
        i32.const 4096 i32.gt_u if i32.const 4 call $fail end
        local.get $to local.get $count i32.store offset=4
        local.get $count i32.eqz
        if local.get $to i32.const 0 i32.store
        else
          local.get $to i32.const ${stride} local.get $count i32.mul i32.const ${item.align} call $alloc local.tee $target i32.store
          i32.const 0 local.set $index
          block $done loop $loop
            local.get $index local.get $count i32.ge_u br_if $done
            local.get $from i32.load local.get $index i32.const ${stride} i32.mul i32.add
            local.get $target local.get $index i32.const ${stride} i32.mul i32.add
            call ${copyItem}
            local.get $index i32.const 1 i32.add local.set $index br $loop
          end end
        end`;
    } else if (type.kind === "record") {
      const layout = layoutCollectionType(type);
      body = type.fields
        .map((field) => {
          const offset = layout.fields?.find(
            (candidate) => candidate.name === field.name,
          )?.offset;
          if (offset === undefined)
            throw new Error("INVALID_IR: record layout");
          return `local.get $from i32.const ${offset} i32.add local.get $to i32.const ${offset} i32.add call ${this.ensureCopyFunction(field.type)}`;
        })
        .join("\n");
    } else if (type.kind === "union") {
      const layout = layoutCollectionType(type);
      let chain = "i32.const 5 call $fail";
      for (let index = type.variants.length - 1; index >= 0; index--) {
        const variant = type.variants[index]!,
          fields = layout.variants?.[index]?.fields;
        if (!fields) throw new Error("INVALID_IR: union layout");
        const copies = variant.fields
          .map((field) => {
            const offset = fields.find(
              (candidate) => candidate.name === field.name,
            )?.offset;
            if (offset === undefined)
              throw new Error("INVALID_IR: union field");
            return `local.get $from i32.const ${offset} i32.add local.get $to i32.const ${offset} i32.add call ${this.ensureCopyFunction(field.type)}`;
          })
          .join("\n");
        chain = `local.get $tag i32.const ${index} i32.eq if ${copies} else ${chain} end`;
      }
      body = `local.get $from i32.load local.tee $tag local.get $to i32.store ${chain}`;
    } else throw new Error("INVALID_IR: non-wire copy type");
    this.copyFunctions.push(`(func ${name} (param $from i32) (param $to i32)
      (local $count i32) (local $target i32) (local $index i32) (local $tag i32)
      ${body})`);
    return name;
  }

  private emitConcat(a: string, b: string, locals: string[]): string {
    const left = this.fresh("concatLeft"),
      right = this.fresh("concatRight"),
      output = this.fresh("concatOutput"),
      length = this.fresh("concatLength");
    locals.push(left, right, output, length);
    return `${a} local.set ${left} ${b} local.set ${right}
      local.get ${left} i32.load offset=4 local.get ${right} i32.load offset=4 i32.add local.tee ${length}
      i32.const 16384 i32.gt_u if i32.const 4 call $fail end
      i32.const 8 i32.const 4 call $alloc local.tee ${output}
      local.get ${length} i32.const 1 call $alloc i32.store
      local.get ${output} local.get ${length} i32.store offset=4
      local.get ${left} i32.load local.get ${output} i32.load local.get ${left} i32.load offset=4 call $copyBytes
      local.get ${right} i32.load local.get ${output} i32.load local.get ${left} i32.load offset=4 i32.add local.get ${right} i32.load offset=4 call $copyBytes
      local.get ${output}`;
  }

  private emitScalarLength(value: string, locals: string[]): string {
    const string = this.fresh("scalarString"),
      index = this.fresh("scalarIndex"),
      count = this.fresh("scalarCount"),
      byte = this.fresh("scalarByte");
    locals.push(string, index, count, byte);
    return `${value} local.set ${string} i32.const 0 local.set ${index} i32.const 0 local.set ${count}
      block $scalarDone loop $scalarLoop local.get ${index} local.get ${string} i32.load offset=4 i32.ge_u br_if $scalarDone
        local.get ${string} i32.load local.get ${index} i32.add i32.load8_u local.tee ${byte}
        i32.const 128 i32.lt_u if (result i32) i32.const 1 else local.get ${byte} i32.const 224 i32.lt_u if (result i32) i32.const 2 else local.get ${byte} i32.const 240 i32.lt_u if (result i32) i32.const 3 else i32.const 4 end end end
        local.get ${index} i32.add local.set ${index}
        local.get ${count} i32.const 1 i32.add local.set ${count} br $scalarLoop
      end end local.get ${count}`;
  }
}

export function emitNativeCollectionWat(
  program: CheckedCollectionProgram,
): string {
  return new NativeCompiler(program).compile();
}
