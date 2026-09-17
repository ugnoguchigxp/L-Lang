import type {
  CheckedCollectionFunction,
  CheckedCollectionProgram,
  CollectionBody,
  CollectionExpression,
  CollectionStatement,
  CollectionType,
} from "./llang-module-collection-ir";
import { canonicalCollectionType } from "./llang-module-collection-ir";

const safe = (value: string) => value.replace(/[^A-Za-z0-9_$]/g, "_");
function typeText(type: CollectionType): string {
  if (type.kind === "boolean" || type.kind === "string") return type.kind;
  if (type.kind === "i32" || type.kind === "parameter")
    return type.kind === "parameter" ? "unknown" : "number";
  if (type.kind === "list") return `ReadonlyArray<${typeText(type.element)}>`;
  if (type.kind === "function")
    return `(${type.parameters.map((x, i) => `p${i}: ${typeText(x)}`).join(", ")}) => ${typeText(type.returns)}`;
  if (type.kind === "record")
    return `{ ${type.fields.map((f) => `${JSON.stringify(f.name)}: ${typeText(f.type)}`).join("; ")} }`;
  return type.variants
    .map(
      (v) =>
        `{ tag: ${JSON.stringify(v.tag)}; ${v.fields.map((f) => `${JSON.stringify(f.name)}: ${typeText(f.type)}`).join("; ")} }`,
    )
    .join(" | ");
}
function emitExpression(
  expr: CollectionExpression,
  fn: CheckedCollectionFunction,
  names: Map<string, string>,
): string {
  if (expr.kind === "literal") return JSON.stringify(expr.value);
  if (expr.kind === "param" || expr.kind === "local") return safe(expr.name);
  if (expr.kind === "list")
    return `(_alloc(${8 + expr.elements.length * 8}),[${expr.elements.map((x) => emitExpression(x, fn, names)).join(",")}])`;
  if (expr.kind === "field")
    return `${emitExpression(expr.base, fn, names)}[${JSON.stringify(expr.name)}]`;
  if (expr.kind === "unary")
    return expr.op === "not"
      ? `!(${emitExpression(expr.operand, fn, names)})`
      : `_neg(${emitExpression(expr.operand, fn, names)})`;
  if (expr.kind === "binary") {
    const a = emitExpression(expr.left, fn, names),
      b = emitExpression(expr.right, fn, names);
    if (["+", "-", "*", "/", "%"].includes(expr.op))
      return `_arith(${JSON.stringify(expr.op)},${a},${b})`;
    return `((${a}) ${expr.op} (${b}))`;
  }
  if (expr.kind === "if")
    return `(${emitExpression(expr.condition, fn, names)}?${emitExpression(expr.whenTrue, fn, names)}:${emitExpression(expr.whenFalse, fn, names)})`;
  if (expr.kind === "record" || expr.kind === "variant")
    return `(_alloc(${8 + expr.fields.length * 8}),{${expr.kind === "variant" ? `tag:${JSON.stringify(expr.tag)},` : ""}${expr.fields.map((f) => `${JSON.stringify(f.name)}:${emitExpression(f.value, fn, names)}`).join(",")}})`;
  if (expr.kind === "lambda")
    return `(_alloc(16),(${expr.parameters.map((p) => `${safe(p.name)}:any`).join(",")}):any=>_call(()=>{${emitBody(expr.body, fn, names)}}))`;
  if (expr.kind === "call") {
    const symbol = fn.callees[expr.callee],
      target = symbol && names.get(symbol);
    if (!target) throw new Error(`INVALID_IR: unknown call ${expr.callee}`);
    return `_call(()=>${target}(${expr.arguments.map((x) => emitExpression(x, fn, names)).join(",")}))`;
  }
  if (expr.kind === "invoke")
    return `_call(()=>(${emitExpression(expr.callee, fn, names)})(${expr.arguments.map((x) => emitExpression(x, fn, names)).join(",")}))`;
  if (expr.kind !== "intrinsic")
    throw new Error("INVALID_IR: unsupported expression");
  return `_intrinsic(${JSON.stringify(expr.name)},[${expr.arguments.map((x) => emitExpression(x, fn, names)).join(",")}])`;
}
function emitStatement(
  statement: CollectionStatement,
  fn: CheckedCollectionFunction,
  names: Map<string, string>,
): string {
  if (statement.kind === "const" || statement.kind === "let")
    return `${statement.kind} ${safe(statement.name)}=${emitExpression(statement.value, fn, names)};`;
  if (statement.kind === "assign")
    return `${safe(statement.name)}=${emitExpression(statement.value, fn, names)};`;
  if (statement.kind === "return")
    return `return ${emitExpression(statement.value, fn, names)};`;
  if (statement.kind === "break" || statement.kind === "continue")
    return `${statement.kind};`;
  if (statement.kind === "if")
    return `if(${emitExpression(statement.condition, fn, names)}){${statement.whenTrue.map((x) => emitStatement(x, fn, names)).join("")}}else{${statement.whenFalse.map((x) => emitStatement(x, fn, names)).join("")}}`;
  if (statement.kind === "match") {
    const value = `_match${JSON.stringify(statement).length}`;
    return `{const ${value}=${emitExpression(statement.value, fn, names)};switch(${value}.tag){${statement.cases.map((item) => `case ${JSON.stringify(item.tag)}:{${item.body.map((x) => emitStatement(x, fn, names)).join("")}break;}`).join("")}default:throw new Error("INVALID_ARTIFACT")}}`;
  }
  if (statement.kind === "while")
    return `while((_tick(),${emitExpression(statement.condition, fn, names)})){${statement.body.map((x) => emitStatement(x, fn, names)).join("")}}`;
  if (statement.kind !== "forEach")
    throw new Error("INVALID_IR: unsupported statement");
  return `for(const ${safe(statement.name)} of [...${emitExpression(statement.value, fn, names)}]){_tick();${statement.body.map((x) => emitStatement(x, fn, names)).join("")}}`;
}
function emitBody(
  body: CollectionBody,
  fn: CheckedCollectionFunction,
  names: Map<string, string>,
): string {
  return `${body.statements.map((x) => emitStatement(x, fn, names)).join("")}${body.result ? `return ${emitExpression(body.result, fn, names)};` : ""}`;
}
export function emitCollectionModuleTypeScript(
  program: CheckedCollectionProgram,
): string {
  const names = new Map(
    program.functions.map((fn, i) => [fn.symbol, `_f${i}_${safe(fn.name)}`]),
  );
  const functions = program.functions
    .map(
      (fn) =>
        `function ${names.get(fn.symbol)}(${fn.parameters.map((p) => `${safe(p.name)}:any`).join(",")}):any{_tick();${emitBody(fn.body, fn, names)}}`,
    )
    .join("\n");
  const entry = names.get(program.entry);
  if (!entry) throw new Error("INVALID_IR: entry function missing");
  return `// Generated by L-Lang module-collection-v1. Do not edit.
let _fuel=1000000,_depth=0,_arena=0;
const _inputSchema=${JSON.stringify(canonicalCollectionType(program.entryInput))},_outputSchema=${JSON.stringify(canonicalCollectionType(program.entryOutput))};
function _validate(t:any,v:any,state:{elements:number},path:string,depth=0,seen=new WeakSet<object>()):void{if(depth>64)throw new Error("RESOURCE_LIMIT");if(t==="boolean"||t==="string"){if(typeof v!==t)throw new Error("INVALID_ARTIFACT: "+path);if(t==="string"){if(new TextEncoder().encode(v).length>16384)throw new Error("RESOURCE_LIMIT");for(let i=0;i<v.length;i++){const c=v.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=v.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))throw new Error("INVALID_ARTIFACT: "+path)}else if(c>=0xdc00&&c<=0xdfff)throw new Error("INVALID_ARTIFACT: "+path)}}return}if(t==="i32"){if(!Number.isInteger(v)||v< -2147483648||v>2147483647)throw new Error("INVALID_ARTIFACT: "+path);return}if(t.list){if(!Array.isArray(v)||seen.has(v))throw new Error("INVALID_ARTIFACT: "+path);seen.add(v);state.elements+=v.length;if(v.length>4096||state.elements>16384)throw new Error("RESOURCE_LIMIT");for(const x of v)_validate(t.list,x,state,path,depth+1,seen);seen.delete(v);return}if(!v||typeof v!=="object"||Array.isArray(v)||(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)||seen.has(v))throw new Error("INVALID_ARTIFACT: "+path);seen.add(v);const d=Object.getOwnPropertyDescriptors(v);let fields:any[];if(t.kind==="record")fields=t.fields;else if(t.kind==="union"){const tag=d.tag;if(!tag?.enumerable||!("value" in tag))throw new Error("INVALID_ARTIFACT: "+path);const variant=t.variants.find((x:any)=>x.tag===tag.value);if(!variant)throw new Error("INVALID_ARTIFACT: "+path);fields=variant.fields}else throw new Error("INVALID_ARTIFACT: "+path);const names=[...fields.map((f:any)=>f.name),...(t.kind==="union"?["tag"]:[])];if(Object.keys(d).length!==names.length||names.some((x:string)=>!d[x]?.enumerable||!("value" in d[x])))throw new Error("INVALID_ARTIFACT: "+path);for(const f of fields)_validate(f.type,d[f.name].value,state,path+"."+f.name,depth+1,seen);seen.delete(v)}
function _layout(t:any):{size:number;align:number}{if(t==="boolean"||t==="i32")return{size:4,align:4};if(t==="string"||t.list)return{size:8,align:4};if(t.kind==="record"){let n=0;for(const f of t.fields){const l=_layout(f.type);n=_align(n,l.align)+l.size}return{size:_align(n,4),align:4}}let size=4;for(const variant of t.variants){let n=4;for(const f of variant.fields){const l=_layout(f.type);n=_align(n,l.align)+l.size}size=Math.max(size,_align(n,4))}return{size,align:4}}
function _align(n:number,a:number):number{return Math.ceil(n/a)*a}
function _wireSize(t:any,v:any):number{let cursor=_align(_layout(t).size,4);const walk=(type:any,value:any):void=>{if(type==="string"){cursor+=new TextEncoder().encode(value).length;return}if(type==="boolean"||type==="i32")return;if(type.list){const l=_layout(type.list),stride=_align(l.size,l.align);if(value.length){cursor=_align(cursor,l.align);cursor+=value.length*stride;for(const x of value)walk(type.list,x)}return}const fields=type.kind==="record"?type.fields:type.variants.find((x:any)=>x.tag===value.tag).fields;for(const f of fields)walk(f.type,value[f.name])};walk(t,v);return cursor}
function _tick(n:number=1):void{if((_fuel-=n)<0)throw new Error("RESOURCE_LIMIT");}
function _alloc(n:number):void{if((_arena+=n)>4194304)throw new Error("RESOURCE_LIMIT");}
function _call<T>(f:()=>T):T{_tick();if(++_depth>64){_depth--;throw new Error("RESOURCE_LIMIT")}try{return f();}finally{_depth--;}}
function _arith(op:string,a:number,b:number):number{_tick();if((op==="/"||op==="%")&&b===0)throw new Error("DIVISION_BY_ZERO");const n=op==="+"?a+b:op==="-"?a-b:op==="*"?a*b:op==="/"?Math.trunc(a/b):a%b;if(!Number.isInteger(n)||n< -2147483648||n>2147483647)throw new Error("ARITHMETIC_OVERFLOW");return n;}
function _neg(a:number):number{return _arith("-",0,a)}
function _intrinsic(n:string,a:any[]):any{_tick();const xs:any[]=a[0];if(n==="concat"){const v=String(a[0])+String(a[1]);_alloc(new TextEncoder().encode(v).length);return v}if(n==="scalarLength")return [...String(a[0])].length;if(n==="length")return xs.length;if(n==="at"){if(a[1]<0||a[1]>=xs.length)throw new Error("INDEX_OUT_OF_BOUNDS");return structuredClone(xs[a[1]])}if(n==="set"){if(a[1]<0||a[1]>=xs.length)throw new Error("INDEX_OUT_OF_BOUNDS");_alloc(8+xs.length*8);const o=structuredClone(xs);o[a[1]]=structuredClone(a[2]);return o}if(n==="append"){if(xs.length>=4096)throw new Error("RESOURCE_LIMIT");_alloc(8+(xs.length+1)*8);return[...structuredClone(xs),structuredClone(a[1])]}if(n==="map"){_alloc(8+xs.length*8);return xs.map(a[1])}if(n==="filter"){_alloc(8+xs.length*8);const o=xs.filter(a[1]);return structuredClone(o)}if(n==="fold")return xs.reduce(a[2],a[1]);if(n==="stableSort"){let s:any[]=structuredClone(xs),t:any[]=new Array(s.length);_alloc(16+s.length*16);for(let w=1;w<s.length;w*=2){for(let q=0;q<s.length;q+=2*w){let i=q,j=Math.min(q+w,s.length),ie=j,je=Math.min(q+2*w,s.length),k=q;while(i<ie||j<je){_tick();if(j>=je||(i<ie&&a[1](s[i],s[j])<=0))t[k++]=s[i++];else t[k++]=s[j++]}}[s,t]=[t,s]}return s}throw new Error("INVALID_ARTIFACT")}
${functions}
export type EntryInput=${typeText(program.entryInput)};
export type EntryOutput=${typeText(program.entryOutput)};
export function evaluate(input:EntryInput):EntryOutput{_fuel=1000000;_depth=0;_arena=0;_validate(_inputSchema,input,{elements:0},"input");if(_wireSize(_inputSchema,input)>262144)throw new Error("RESOURCE_LIMIT");const result=structuredClone(_call(()=>${entry}(structuredClone(input))));_validate(_outputSchema,result,{elements:0},"output");if(_wireSize(_outputSchema,result)>262144)throw new Error("RESOURCE_LIMIT");return result as EntryOutput;}
`;
}
export function emitCollectionModuleJsonc(
  program: CheckedCollectionProgram,
): Map<string, string> {
  return new Map(
    program.modules.map((module) => {
      const source = {
        ...module.source,
        imports: module.source.imports.map((x) => ({
          ...x,
          from: x.from.replace(/\.ts$/, ".llang.jsonc"),
        })),
      };
      return [
        `${module.id}.llang.jsonc`,
        `${JSON.stringify(source, null, 2)}\n`,
      ];
    }),
  );
}
