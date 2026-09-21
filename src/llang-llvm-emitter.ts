import type { LlvmKernelPlanV1 } from "./llang-llvm-kernel-ir";

export type LlvmKernelTarget = "wasm32" | "native-arm64";

export function emitLlvmKernelIr(
  plan: LlvmKernelPlanV1,
  target: LlvmKernelTarget,
  triple: string,
  dataLayout: string,
): string {
  const targetHeader = `target datalayout = ${JSON.stringify(dataLayout)}\ntarget triple = ${JSON.stringify(triple)}`;
  return `source_filename = "llang-llvm-kernel-v1"
${targetHeader}

declare { i32, i1 } @llvm.sadd.with.overflow.i32(i32, i32)
${target === "wasm32" ? "declare i32 @llvm.wasm.memory.size.i32(i32 immarg)" : ""}

define internal i32 @llang_sum_kernel(ptr %values, i32 %count, ptr %out) {
entry:
  %count.ok = icmp ule i32 %count, ${plan.maximumElements}
  br i1 %count.ok, label %start, label %invalid

start:
  %empty = icmp eq i32 %count, 0
  br i1 %empty, label %done.zero, label %loop

loop:
  %index = phi i32 [ 0, %start ], [ %next.index, %continue ]
  %sum = phi i32 [ 0, %start ], [ %next.sum, %continue ]
  %element = getelementptr i32, ptr %values, i32 %index
  %value = load i32, ptr %element, align 1
  %pair = call { i32, i1 } @llvm.sadd.with.overflow.i32(i32 %sum, i32 %value)
  %next.sum = extractvalue { i32, i1 } %pair, 0
  %overflow = extractvalue { i32, i1 } %pair, 1
  br i1 %overflow, label %overflowed, label %continue

continue:
  %next.index = add i32 %index, 1
  %complete = icmp eq i32 %next.index, %count
  br i1 %complete, label %done, label %loop

done:
  store i32 %next.sum, ptr %out, align 1
  ret i32 0

done.zero:
  store i32 0, ptr %out, align 1
  ret i32 0

overflowed:
  ret i32 1

invalid:
  ret i32 2
}

${target === "wasm32" ? wasmWrapper() : nativeWrapper()}
`;
}

function nativeWrapper(): string {
  return `define i32 @llang_checked_sum_i32(ptr %values, i32 %count, ptr %out) {
entry:
  %status = call i32 @llang_sum_kernel(ptr %values, i32 %count, ptr %out)
  ret i32 %status
}`;
}

function wasmWrapper(): string {
  return `define i32 @llang_checked_sum_i32(ptr %values, i32 %count, ptr %out) {
entry:
  %count.ok = icmp ule i32 %count, 4096
  br i1 %count.ok, label %ranges, label %invalid

ranges:
  %pages = call i32 @llvm.wasm.memory.size.i32(i32 0)
  %memory.bytes = shl i32 %pages, 16
  %values.addr = ptrtoint ptr %values to i32
  %out.addr = ptrtoint ptr %out to i32
  %input.bytes = shl i32 %count, 2
  %values.base.ok = icmp ule i32 %values.addr, %memory.bytes
  %values.remaining = sub i32 %memory.bytes, %values.addr
  %values.length.ok = icmp ule i32 %input.bytes, %values.remaining
  %values.ok = and i1 %values.base.ok, %values.length.ok
  %out.base.ok = icmp ule i32 %out.addr, %memory.bytes
  %out.remaining = sub i32 %memory.bytes, %out.addr
  %out.length.ok = icmp uge i32 %out.remaining, 4
  %out.ok = and i1 %out.base.ok, %out.length.ok
  %empty = icmp eq i32 %input.bytes, 0
  %input.end = add i32 %values.addr, %input.bytes
  %out.end = add i32 %out.addr, 4
  %left.before.right.end = icmp ult i32 %values.addr, %out.end
  %right.before.left.end = icmp ult i32 %out.addr, %input.end
  %overlap.nonempty = and i1 %left.before.right.end, %right.before.left.end
  %overlap = select i1 %empty, i1 false, i1 %overlap.nonempty
  %not.overlap = xor i1 %overlap, true
  %ranges.ok.first = and i1 %values.ok, %out.ok
  %ranges.ok = and i1 %ranges.ok.first, %not.overlap
  br i1 %ranges.ok, label %run, label %invalid

run:
  %status = call i32 @llang_sum_kernel(ptr %values, i32 %count, ptr %out)
  ret i32 %status

invalid:
  ret i32 2
}`;
}

export function emitDirectKernelWat(plan: LlvmKernelPlanV1): string {
  return `(module
    (memory (export "memory") 2 2)
    (func (export "llang_checked_sum_i32")
      (param $values i32) (param $count i32) (param $out i32) (result i32)
      (local $bytes i32) (local $index i32) (local $sum i64) (local $value i32)
      local.get $count i32.const ${plan.maximumElements} i32.gt_u
      if i32.const 2 return end
      local.get $count i32.const 2 i32.shl local.set $bytes
      local.get $values i32.const 131072 i32.gt_u
      if i32.const 2 return end
      local.get $bytes i32.const 131072 local.get $values i32.sub i32.gt_u
      if i32.const 2 return end
      local.get $out i32.const 131072 i32.gt_u
      if i32.const 2 return end
      i32.const 4 i32.const 131072 local.get $out i32.sub i32.gt_u
      if i32.const 2 return end
      local.get $bytes i32.eqz
      if
      else
        local.get $values local.get $out i32.const 4 i32.add i32.lt_u
        local.get $out local.get $values local.get $bytes i32.add i32.lt_u
        i32.and
        if i32.const 2 return end
      end
      block $done loop $loop
        local.get $index local.get $count i32.ge_u br_if $done
        local.get $values local.get $index i32.const 2 i32.shl i32.add
        i32.load align=1 local.set $value
        local.get $sum local.get $value i64.extend_i32_s i64.add local.tee $sum
        i64.const -2147483648 i64.lt_s
        local.get $sum i64.const 2147483647 i64.gt_s i32.or
        if i32.const 1 return end
        local.get $index i32.const 1 i32.add local.set $index
        br $loop
      end end
      local.get $out local.get $sum i32.wrap_i64 i32.store align=1
      i32.const 0))`;
}
