import { dlopen, FFIType, ptr } from "bun:ffi";

const libraryPath = process.argv[2];
if (!libraryPath) throw new Error("missing native library path");

const input = (await Bun.stdin.json()) as unknown;
if (
  !input ||
  typeof input !== "object" ||
  Array.isArray(input) ||
  ![
    "iterations,values",
    "iterations,values,warmup",
    "values",
    "values,warmup",
  ].includes(Object.keys(input).sort().join(",")) ||
  !Array.isArray((input as { values?: unknown }).values) ||
  (input as { values: unknown[] }).values.length > 4096 ||
  (input as { values: unknown[] }).values.some(
    (value) =>
      !Number.isInteger(value) ||
      Number(value) < -2_147_483_648 ||
      Number(value) > 2_147_483_647,
  )
)
  throw new Error("invalid native runner input");

const values = new Int32Array((input as { values: number[] }).values),
  iterations = Number((input as { iterations?: number }).iterations ?? 1),
  warmup = Number((input as { warmup?: number }).warmup ?? 0),
  storage = values.length === 0 ? new Int32Array(1) : values,
  output = new Int32Array([0x5a5a5a5a]),
  before = [...values];
if (
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  iterations > 10_000_000 ||
  !Number.isSafeInteger(warmup) ||
  warmup < 0 ||
  warmup > 1_000_000
)
  throw new Error("invalid native runner iteration count");

const library = dlopen(libraryPath, {
  llang_checked_sum_i32: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
});
try {
  for (let index = 0; index < warmup; index++)
    library.symbols.llang_checked_sum_i32(
      ptr(storage),
      values.length,
      ptr(output),
    );
  const started = Bun.nanoseconds();
  let status = 0;
  for (let index = 0; index < iterations; index++)
    status = Number(
      library.symbols.llang_checked_sum_i32(
        ptr(storage),
        values.length,
        ptr(output),
      ),
    );
  const kernelNs = Bun.nanoseconds() - started;
  process.stdout.write(
    `${JSON.stringify({
      status,
      ...(status === 0 ? { value: output[0] } : {}),
      inputUnchanged: JSON.stringify(before) === JSON.stringify([...values]),
      kernelNs,
      peakRssBytes: process.resourceUsage().maxRSS,
    })}\n`,
  );
} finally {
  library.close();
}
