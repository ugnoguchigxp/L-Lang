import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { emitLlvmKernelIr, type LlvmKernelTarget } from "./llang-llvm-emitter";
import type { LlvmKernelPlanV1 } from "./llang-llvm-kernel-ir";

export type LlvmOptimization = "O0" | "O2" | "O3";
export type LlvmToolchain = Readonly<{
  version: string;
  toolVersions: Readonly<
    Record<"clang" | "llvmAs" | "opt" | "llc" | "wasmLd", string>
  >;
  bin: string;
  lldBin: string;
  clang: string;
  llvmAs: string;
  opt: string;
  llc: string;
  wasmLd: string;
  wasmTriple: string;
  wasmDataLayout: string;
  nativeTriple: string;
  nativeDataLayout: string;
  macosSdkPath: string;
  macosSdkVersion: string;
}>;

export type LlvmBuildArtifact = Readonly<{
  target: LlvmKernelTarget;
  optimization: LlvmOptimization;
  rawIrPath: string;
  optimizedIrPath: string;
  artifactPath: string;
  rawIrHash: string;
  optimizedIrHash: string;
  artifactHash: string;
  artifactBytes: number;
  phasesMs: Readonly<Record<string, number>>;
}>;

const MAX_OUTPUT = 1024 * 1024;
const HASH = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export async function discoverLlvmToolchain(
  llvmBin?: string,
  lldBin?: string,
): Promise<LlvmToolchain> {
  const pathDirectories = (process.env.PATH ?? "").split(":").filter(Boolean),
    requestedLlvm = llvmBin ?? process.env.LLANG_LLVM_BIN,
    requestedLld = lldBin ?? process.env.LLANG_LLD_BIN,
    bin = await findToolDirectory(
      requestedLlvm
        ? [requestedLlvm]
        : [
            ...pathDirectories,
            "/opt/homebrew/opt/llvm/bin",
            "/usr/local/opt/llvm/bin",
          ],
      ["clang", "llvm-as", "opt", "llc"],
      Boolean(requestedLlvm),
    ),
    lld = await findToolDirectory(
      requestedLld
        ? [requestedLld]
        : [
            bin,
            ...pathDirectories,
            "/opt/homebrew/opt/lld/bin",
            "/usr/local/opt/lld/bin",
          ],
      ["wasm-ld"],
      Boolean(requestedLld),
    ),
    clang = join(bin, "clang"),
    llvmAs = join(bin, "llvm-as"),
    opt = join(bin, "opt"),
    llc = join(bin, "llc"),
    wasmLd = join(lld, "wasm-ld");
  await Promise.all(
    [clang, llvmAs, opt, llc, wasmLd].map(async (file) => {
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`TOOLCHAIN_UNAVAILABLE: ${file}`);
    }),
  );
  const versions = await Promise.all(
      [clang, llvmAs, opt, llc, wasmLd].map((tool) =>
        runTool(tool, ["--version"]),
      ),
    ),
    parsed = versions.map(
      (item) => item.stdout.match(/(?:version|LLD)\s+(\d+\.\d+\.\d+)/i)?.[1],
    );
  if (parsed.some((item) => !item) || new Set(parsed).size !== 1)
    throw new Error(
      `TOOLCHAIN_UNAVAILABLE: LLVM version mismatch ${parsed.join(",")}`,
    );
  const llcVersion = versions[3]?.stdout ?? "";
  if (!llcVersion.includes("wasm32"))
    throw new Error("TOOLCHAIN_UNAVAILABLE: wasm32 target is unavailable");
  const wasm = await queryTarget(clang, "wasm32-unknown-unknown"),
    native = await queryTarget(clang, "arm64-apple-macosx"),
    [sdkPath, sdkVersion] = await Promise.all([
      runTool("/usr/bin/xcrun", ["--show-sdk-path"]),
      runTool("/usr/bin/xcrun", ["--show-sdk-version"]),
    ]);
  return Object.freeze({
    version: parsed[0] as string,
    toolVersions: Object.freeze({
      clang: parsed[0] as string,
      llvmAs: parsed[1] as string,
      opt: parsed[2] as string,
      llc: parsed[3] as string,
      wasmLd: parsed[4] as string,
    }),
    bin,
    lldBin: lld,
    clang,
    llvmAs,
    opt,
    llc,
    wasmLd,
    wasmTriple: wasm.triple,
    wasmDataLayout: wasm.dataLayout,
    nativeTriple: native.triple,
    nativeDataLayout: native.dataLayout,
    macosSdkPath: sdkPath.stdout.trim(),
    macosSdkVersion: sdkVersion.stdout.trim(),
  });
}

async function findToolDirectory(
  candidates: readonly string[],
  tools: readonly string[],
  exclusive: boolean,
): Promise<string> {
  for (const candidate of [...new Set(candidates)]) {
    const directory = resolve(candidate);
    if (
      (
        await Promise.all(
          tools.map((tool) =>
            stat(join(directory, tool))
              .then((value) => value.isFile())
              .catch(() => false),
          ),
        )
      ).every(Boolean)
    )
      return realpath(directory);
    if (exclusive) break;
  }
  throw new Error(
    `TOOLCHAIN_UNAVAILABLE: missing ${tools.join(", ")} in ${candidates.join(", ")}`,
  );
}

async function queryTarget(clang: string, target: string) {
  const result = await runTool(clang, [
      "-target",
      target,
      "-S",
      "-emit-llvm",
      "-x",
      "c",
      "/dev/null",
      "-o",
      "-",
    ]),
    triple = result.stdout.match(/^target triple = "([^"]+)"$/m)?.[1],
    dataLayout = result.stdout.match(/^target datalayout = "([^"]+)"$/m)?.[1];
  if (!triple || !dataLayout)
    throw new Error(`TOOLCHAIN_UNAVAILABLE: cannot query ${target}`);
  return { triple, dataLayout };
}

export async function buildLlvmKernel(
  plan: LlvmKernelPlanV1,
  toolchain: LlvmToolchain,
  target: LlvmKernelTarget,
  optimization: LlvmOptimization,
  outputDirectory: string,
  limits: Readonly<{
    toolTimeoutMs: number;
    outputBytes: number;
    artifactBytes: number;
  }> = {
    toolTimeoutMs: 30_000,
    outputBytes: MAX_OUTPUT,
    artifactBytes: 1024 * 1024,
  },
): Promise<LlvmBuildArtifact> {
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: false });
  const triple =
      target === "wasm32" ? toolchain.wasmTriple : toolchain.nativeTriple,
    layout =
      target === "wasm32"
        ? toolchain.wasmDataLayout
        : toolchain.nativeDataLayout,
    rawIrPath = join(out, "kernel.raw.ll"),
    rawBitcode = join(out, "kernel.raw.bc"),
    optimizedIrPath = join(out, `kernel.${optimization}.ll`),
    optimizedBitcode = join(out, `kernel.${optimization}.bc`),
    objectPath = join(out, "kernel.o"),
    artifactPath = join(
      out,
      target === "wasm32" ? "kernel.wasm" : "libllang_llvm_sum.dylib",
    ),
    phases: Record<string, number> = {};
  const generatedAt = performance.now();
  await writeFile(rawIrPath, emitLlvmKernelIr(plan, target, triple, layout), {
    flag: "wx",
  });
  phases.emit = performance.now() - generatedAt;
  phases.assemble = await timed(() =>
    runTool(toolchain.llvmAs, [rawIrPath, "-o", rawBitcode], limits),
  );
  const passes = optimization === "O0" ? "verify" : `default<${optimization}>`;
  phases.optimize = await timed(() =>
    runTool(
      toolchain.opt,
      [`-passes=${passes}`, "-S", rawBitcode, "-o", optimizedIrPath],
      limits,
    ),
  );
  const optimizedText = await readFile(optimizedIrPath, "utf8");
  await writeFile(
    optimizedIrPath,
    optimizedText.replace(
      /^; ModuleID = .*$/m,
      "; ModuleID = 'llang-llvm-kernel-v1'",
    ),
  );
  phases.reassemble = await timed(() =>
    runTool(
      toolchain.llvmAs,
      [optimizedIrPath, "-o", optimizedBitcode],
      limits,
    ),
  );
  phases.codegen = await timed(() =>
    runTool(
      toolchain.llc,
      [
        `-mtriple=${triple}`,
        "-filetype=obj",
        ...(target === "native-arm64" ? ["-relocation-model=pic"] : []),
        optimizedBitcode,
        "-o",
        objectPath,
      ],
      limits,
    ),
  );
  phases.link = await timed(() =>
    target === "wasm32"
      ? runTool(
          toolchain.wasmLd,
          [
            "--no-entry",
            "--export=llang_checked_sum_i32",
            "--export-memory",
            "--initial-memory=131072",
            "--max-memory=131072",
            "--strip-all",
            objectPath,
            "-o",
            artifactPath,
          ],
          limits,
        )
      : runTool(
          toolchain.clang,
          [
            "-dynamiclib",
            objectPath,
            "-Wl,-install_name,@rpath/libllang_llvm_sum.dylib",
            "-o",
            artifactPath,
          ],
          limits,
        ),
  );
  const artifactInfo = await lstat(artifactPath).catch(() => undefined);
  if (!artifactInfo?.isFile())
    throw new Error("LLVM_ARTIFACT_LIMIT: artifact is not a regular file");
  if (artifactInfo.size > limits.artifactBytes)
    throw new Error("LLVM_ARTIFACT_LIMIT: artifact exceeds configured limit");
  const [rawIr, optimizedIr, artifact] = await Promise.all([
    readFile(rawIrPath),
    readFile(optimizedIrPath),
    readFile(artifactPath),
  ]);
  return Object.freeze({
    target,
    optimization,
    rawIrPath,
    optimizedIrPath,
    artifactPath,
    rawIrHash: HASH(rawIr),
    optimizedIrHash: HASH(optimizedIr),
    artifactHash: HASH(artifact),
    artifactBytes: artifact.length,
    phasesMs: Object.freeze(phases),
  });
}

export async function runTool(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    cwd?: string;
    timeoutMs?: number;
    outputBytes?: number;
  }> = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([executable, ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
    timeoutMs = options.timeoutMs ?? 30_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  let stdoutBytes: Uint8Array, stderrBytes: Uint8Array, exitCode: number;
  try {
    [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
      readBounded(child.stdout, options.outputBytes ?? MAX_OUTPUT),
      readBounded(child.stderr, options.outputBytes ?? MAX_OUTPUT),
      child.exited,
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (timedOut)
    throw new Error(`LLVM_TOOL_TIMEOUT: ${executable} exceeded ${timeoutMs}ms`);
  const stdout = new TextDecoder().decode(stdoutBytes),
    stderr = new TextDecoder().decode(stderrBytes);
  if (exitCode !== 0)
    throw new Error(
      `LLVM_TOOL_FAILED: ${executable} exited ${exitCode}: ${stderr.slice(0, 4096)}`,
    );
  return { stdout, stderr };
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) throw new Error("LLVM_TOOL_OUTPUT_LIMIT");
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function timed(action: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await action();
  return performance.now() - started;
}
