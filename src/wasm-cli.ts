import { resolve } from "node:path";
import { WasmError } from "./wasm-contract";

export async function runWasmCli(args: string[]): Promise<unknown> {
  const [command, target, flag, value] = args;
  if (args.length !== 4 || !target || !value)
    throw new WasmError(
      "USAGE",
      "wasm build <source> --out-dir <directory> | wasm run <manifest> --input <json>",
    );
  if (command === "build" && flag === "--out-dir") {
    const { buildWasm } = await import("./wasm-compiler");
    return buildWasm(resolve(target), resolve(value));
  }
  if (command === "run" && flag === "--input") {
    const { loadWasmPredicate } = await import("./wasm-runtime");
    const { readBounded } = await import("./wasm-artifact");
    const predicate = await loadWasmPredicate(resolve(target));
    const input: unknown = JSON.parse(
      new TextDecoder().decode(await readBounded(resolve(value))),
    );
    return { result: predicate.evaluate(input) };
  }
  throw new WasmError("USAGE", "unknown command or option");
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runWasmCli(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
