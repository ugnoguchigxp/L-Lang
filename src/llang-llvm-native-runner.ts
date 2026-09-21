import { join } from "node:path";

export type NativeKernelResult = Readonly<{
  kind: "return" | "timeout" | "signal" | "error";
  status?: number;
  value?: number;
  inputUnchanged?: boolean;
  kernelNs?: number;
  processNs?: number;
  peakRssBytes?: number;
  detail?: string;
}>;

export async function runNativeKernel(
  libraryPath: string,
  values: readonly number[],
  timeoutMs = 5_000,
  measurement: Readonly<{ iterations?: number; warmup?: number }> = {},
): Promise<NativeKernelResult> {
  let timedOut = false;
  const processStarted = Bun.nanoseconds();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "llang-llvm-native-child.ts"),
      libraryPath,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdin: new Blob([JSON.stringify({ values, ...measurement })]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  let stdout: string, stderr: string, exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      readSmall(child.stdout),
      readSmall(child.stderr),
      child.exited,
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    return Object.freeze({
      kind: "error",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
  if (exitCode !== 0) {
    if (timedOut)
      return Object.freeze({ kind: "timeout", detail: `after ${timeoutMs}ms` });
    const signal = child.signalCode;
    return Object.freeze({
      kind: signal ? "signal" : "error",
      detail: `${signal ?? exitCode}: ${stderr.slice(0, 4096)}`,
    });
  }
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !==
        (value.status === 0
          ? "inputUnchanged,kernelNs,peakRssBytes,status,value"
          : "inputUnchanged,kernelNs,peakRssBytes,status") ||
      !Number.isInteger(value.status) ||
      ![0, 1, 2].includes(Number(value.status)) ||
      typeof value.inputUnchanged !== "boolean" ||
      typeof value.kernelNs !== "number" ||
      !Number.isFinite(value.kernelNs) ||
      value.kernelNs < 0 ||
      !Number.isSafeInteger(value.peakRssBytes) ||
      Number(value.peakRssBytes) < 0 ||
      (value.status === 0 && !Number.isInteger(value.value))
    )
      throw new Error("invalid result shape");
    return Object.freeze({
      kind: "return",
      status: Number(value.status),
      ...(value.status === 0 ? { value: Number(value.value) } : {}),
      inputUnchanged: value.inputUnchanged,
      kernelNs: value.kernelNs,
      peakRssBytes: Number(value.peakRssBytes),
      processNs: Bun.nanoseconds() - processStarted,
    });
  } catch (error) {
    return Object.freeze({
      kind: "error",
      detail: `invalid native runner output: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function readSmall(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > 64 * 1024) throw new Error("NATIVE_RUNNER_OUTPUT_LIMIT");
    chunks.push(chunk);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(all).trim();
}
