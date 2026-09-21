import { createHash } from "node:crypto";
import binaryen from "binaryen";
import { emitDirectKernelWat } from "./llang-llvm-emitter";
import type { LlvmKernelPlanV1 } from "./llang-llvm-kernel-ir";

export const LLVM_KERNEL_MEMORY_BYTES = 2 * 65_536;

type KernelExports = {
  memory: WebAssembly.Memory;
  llang_checked_sum_i32(values: number, count: number, out: number): number;
};

export type KernelInvocation = Readonly<{
  kind: "return" | "trap";
  status?: number;
  value?: number;
  error?: string;
  inputBefore: string | null;
  inputAfter: string | null;
  outputBefore: string | null;
  outputAfter: string | null;
}>;

const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export function emitDirectKernelWasm(plan: LlvmKernelPlanV1): {
  wat: string;
  bytes: Uint8Array;
} {
  const wat = emitDirectKernelWat(plan),
    module = binaryen.parseText(wat);
  try {
    if (!module.validate()) throw new Error("INVALID_LLVM_KERNEL_WAT");
    const bytes = new Uint8Array(module.emitBinary());
    assertLlvmKernelWasm(bytes);
    return { wat, bytes };
  } finally {
    module.dispose();
  }
}

export function assertLlvmKernelWasm(bytes: Uint8Array): WebAssembly.Module {
  if (
    bytes.length > 1024 * 1024 ||
    !WebAssembly.validate(bytes as BufferSource)
  )
    throw new Error("INVALID_LLVM_KERNEL_WASM");
  const module = new WebAssembly.Module(bytes as BufferSource),
    imports = WebAssembly.Module.imports(module),
    exports = WebAssembly.Module.exports(module);
  if (
    imports.length !== 0 ||
    exports.length !== 2 ||
    !exports.some((item) => item.name === "memory" && item.kind === "memory") ||
    !exports.some(
      (item) =>
        item.name === "llang_checked_sum_i32" && item.kind === "function",
    )
  )
    throw new Error("INVALID_LLVM_KERNEL_WASM: unexpected interface");
  const inspected = binaryen.readBinary(bytes);
  try {
    const memory = inspected.getMemoryInfo(),
      functionExport = Array.from(
        { length: inspected.getNumExports() },
        (_, index) => binaryen.getExportInfo(inspected.getExportByIndex(index)),
      ).find((item) => item.name === "llang_checked_sum_i32"),
      functionInfo =
        functionExport?.kind === binaryen.ExternalFunction
          ? binaryen.getFunctionInfo(
              inspected.getFunction(functionExport.value),
            )
          : undefined;
    if (
      memory.initial !== 2 ||
      memory.max !== 2 ||
      memory.shared ||
      memory.is64 ||
      !functionInfo ||
      binaryen.expandType(functionInfo.params).length !== 3 ||
      binaryen
        .expandType(functionInfo.params)
        .some((type) => type !== binaryen.i32) ||
      functionInfo.results !== binaryen.i32
    )
      throw new Error("INVALID_LLVM_KERNEL_WASM: invalid memory or signature");
  } finally {
    inspected.dispose();
  }
  return module;
}

export class LlvmKernelWasmHarness {
  readonly memory: Uint8Array;
  readonly view: DataView;
  readonly #exports: KernelExports;

  constructor(bytes: Uint8Array) {
    const instance = new WebAssembly.Instance(assertLlvmKernelWasm(bytes), {}),
      exports = instance.exports as unknown as KernelExports;
    if (
      !(exports.memory instanceof WebAssembly.Memory) ||
      typeof exports.llang_checked_sum_i32 !== "function" ||
      exports.memory.buffer.byteLength !== LLVM_KERNEL_MEMORY_BYTES
    )
      throw new Error("INVALID_LLVM_KERNEL_WASM: invalid exports");
    this.#exports = exports;
    this.memory = new Uint8Array(exports.memory.buffer);
    this.view = new DataView(exports.memory.buffer);
  }

  invoke(
    values: readonly number[],
    input = 64,
    output = 65_536,
  ): KernelInvocation {
    if (
      values.some(
        (value) =>
          !Number.isInteger(value) ||
          value < -2_147_483_648 ||
          value > 2_147_483_647,
      ) ||
      input < 0 ||
      input > this.memory.length ||
      values.length * 4 > this.memory.length - input
    )
      throw new Error("test harness input is outside memory");
    for (let index = 0; index < values.length; index++)
      this.view.setInt32(input + index * 4, values[index] as number, true);
    return this.invokeRaw(input, values.length, output);
  }

  invokeRaw(values: number, count: number, out: number): KernelInvocation {
    const byteLength =
        Number.isInteger(count) && count >= 0 && count <= 4096 ? count * 4 : -1,
      validInput =
        Number.isInteger(values) &&
        values >= 0 &&
        byteLength >= 0 &&
        values <= this.memory.length &&
        byteLength <= this.memory.length - values,
      validOutput =
        Number.isInteger(out) &&
        out >= 0 &&
        out <= this.memory.length &&
        4 <= this.memory.length - out,
      before = validInput
        ? hash(this.memory.subarray(values, values + byteLength))
        : null,
      outputBefore = validOutput
        ? hash(this.memory.subarray(out, out + 4))
        : null;
    try {
      const status = Number(
          this.#exports.llang_checked_sum_i32(values, count, out),
        ),
        after = validInput
          ? hash(this.memory.subarray(values, values + byteLength))
          : null,
        outputAfter = validOutput
          ? hash(this.memory.subarray(out, out + 4))
          : null;
      return Object.freeze({
        kind: "return" as const,
        status,
        ...(status === 0 && out >= 0 && out + 4 <= this.memory.length
          ? { value: this.view.getInt32(out, true) }
          : {}),
        inputBefore: before,
        inputAfter: after,
        outputBefore,
        outputAfter,
      });
    } catch (error) {
      return Object.freeze({
        kind: "trap" as const,
        error: error instanceof Error ? error.message : String(error),
        inputBefore: before,
        inputAfter: validInput
          ? hash(this.memory.subarray(values, values + byteLength))
          : null,
        outputBefore,
        outputAfter: validOutput
          ? hash(this.memory.subarray(out, out + 4))
          : null,
      });
    }
  }

  benchmark(
    values: readonly number[],
    warmup: number,
    iterations: number,
    input = 64,
    output = 65_536,
  ): Readonly<{
    status: number;
    value?: number;
    kernelNs: number;
    inputUnchanged: boolean;
  }> {
    if (
      values.some(
        (value) =>
          !Number.isInteger(value) ||
          value < -2_147_483_648 ||
          value > 2_147_483_647,
      ) ||
      !Number.isSafeInteger(warmup) ||
      warmup < 0 ||
      warmup > 1_000_000 ||
      !Number.isSafeInteger(iterations) ||
      iterations < 1 ||
      iterations > 10_000_000 ||
      expectedLlvmKernelBoundaryStatus(input, values.length, output) !== 0
    )
      throw new Error("invalid kernel benchmark input");
    for (let index = 0; index < values.length; index++)
      this.view.setInt32(input + index * 4, values[index] as number, true);
    const inputBefore = hash(
      this.memory.subarray(input, input + values.length * 4),
    );
    for (let index = 0; index < warmup; index++)
      this.#exports.llang_checked_sum_i32(input, values.length, output);
    const started = Bun.nanoseconds();
    let status = 0;
    for (let index = 0; index < iterations; index++)
      status = Number(
        this.#exports.llang_checked_sum_i32(input, values.length, output),
      );
    const kernelNs = Bun.nanoseconds() - started;
    return Object.freeze({
      status,
      ...(status === 0 ? { value: this.view.getInt32(output, true) } : {}),
      kernelNs,
      inputUnchanged:
        inputBefore ===
        hash(this.memory.subarray(input, input + values.length * 4)),
    });
  }
}

export function expectedLlvmKernelBoundaryStatus(
  values: number,
  count: number,
  out: number,
): 0 | 2 {
  const u32Max = 0xffff_ffff;
  if (
    ![values, count, out].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= u32Max,
    ) ||
    count > 4096
  )
    return 2;
  const inputBytes = count * 4,
    inputValid =
      values <= LLVM_KERNEL_MEMORY_BYTES &&
      inputBytes <= LLVM_KERNEL_MEMORY_BYTES - values,
    outputValid =
      out <= LLVM_KERNEL_MEMORY_BYTES && 4 <= LLVM_KERNEL_MEMORY_BYTES - out,
    overlaps =
      inputBytes !== 0 && values < out + 4 && out < values + inputBytes;
  return inputValid && outputValid && !overlaps ? 0 : 2;
}
