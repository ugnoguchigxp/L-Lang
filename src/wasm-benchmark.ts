import { stat } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isActiveCustomer } from "../examples/active-customer/is-active-customer.generated";
import { readSemanticResolution } from "./semantic-resolution-reader";
import { readArtifact } from "./wasm-artifact";
import { encodeInput } from "./wasm-contract";
import { contractFromType } from "./wasm-core";
import { loadWasmPredicate } from "./wasm-runtime";

// Exploratory benchmark: no model requests, no synthetic performance gate.
export async function benchmarkWasm(manifestPath: string, iterations = 100000) {
  const start = performance.now();
  const { emitWasm } = await import("./wasm-emitter");
  const emitterLoadMs = performance.now() - start;
  const resolutionStart = performance.now();
  const resolution = await readSemanticResolution(
    resolve(import.meta.dir, "../examples/active-customer/semantic.ts"),
    resolve(import.meta.dir, ".."),
  );
  const lockReadMs = performance.now() - resolutionStart;
  const contract = contractFromType(resolution.schema);
  const emissionStart = performance.now();
  const emitted = emitWasm(resolution.body, contract);
  const emitMs = performance.now() - emissionStart;
  const artifact = await readArtifact(manifestPath);
  const compileStart = performance.now();
  const module = await WebAssembly.compile(artifact.bytes);
  const wasmCompileMs = performance.now() - compileStart;
  const instanceStart = performance.now();
  await WebAssembly.instantiate(module);
  const instantiateMs = performance.now() - instanceStart;
  const runtime = await loadWasmPredicate(manifestPath);
  const inputs = [
    { status: "active" as const, deletedAt: null, email: "" },
    { status: "suspended" as const, deletedAt: null, email: "x" },
    { status: "active" as const, deletedAt: "2026-01-01", email: "x" },
    { status: "active" as const, deletedAt: null, email: undefined },
  ];
  const first = inputs[0];
  if (!first) throw new Error("missing input");
  const cold = performance.now();
  runtime.evaluate(first);
  const firstCallMs = performance.now() - cold;
  let checksum = 0;
  function measure(fn: (input: (typeof inputs)[number]) => boolean) {
    const begin = performance.now();
    for (let i = 0; i < iterations; i++) {
      const input = inputs[i % inputs.length];
      if (input) checksum += Number(fn(input));
    }
    return performance.now() - begin;
  }
  const ts = (input: (typeof inputs)[number]) => isActiveCustomer(input);
  const validatedTs = (input: (typeof inputs)[number]) => {
    encodeInput(contract, input);
    return ts(input);
  };
  for (let i = 0; i < 1000; i++) {
    runtime.evaluate(first);
    ts(first);
    validatedTs(first);
  }
  const samples: { ts: number; validatedTs: number; wasmHost: number }[] = [];
  for (let i = 0; i < 7; i++) {
    // Alternate order to reduce systematic warmup/order bias.
    if (i % 2) {
      const wasmHost = measure(runtime.evaluate);
      samples.push({
        wasmHost,
        validatedTs: measure(validatedTs),
        ts: measure(ts),
      });
    } else {
      const tsMs = measure(ts);
      samples.push({
        ts: tsMs,
        validatedTs: measure(validatedTs),
        wasmHost: measure(runtime.evaluate),
      });
    }
  }
  const summarize = (key: keyof (typeof samples)[number]) => {
    const sorted = samples.map((s) => s[key]).sort((a, b) => a - b);
    return { medianMs: sorted[3], minMs: sorted[0], maxMs: sorted[6] };
  };
  return {
    environment: {
      bun: Bun.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
    },
    iterations,
    samples: 7,
    warmup: 1000,
    emitterLoadMs,
    lockReadMs,
    emitMs,
    wasmCompileMs,
    instantiateMs,
    firstCallMs,
    wasmBytes: emitted.length,
    manifestBytes: (await stat(manifestPath)).size,
    rssBytes: process.memoryUsage().rss,
    ts: summarize("ts"),
    validatedTs: summarize("validatedTs"),
    wasmHost: summarize("wasmHost"),
    checksum,
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path)
    throw new Error("usage: bun run src/wasm-benchmark.ts <manifest.json>");
  console.log(JSON.stringify(await benchmarkWasm(resolve(path)), null, 2));
}
