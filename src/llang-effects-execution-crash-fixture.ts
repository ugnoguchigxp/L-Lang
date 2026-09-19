import { readFile, writeFile } from "node:fs/promises";
import { executeEffectsModuleBundle } from "./llang-effects-execution-evidence";

const [, , manifestPath, grantPath, outputDirectory, counterPath] =
  process.argv;
if (!manifestPath || !grantPath || !outputDirectory || !counterPath)
  throw new Error("INVALID_CRASH_FIXTURE_ARGUMENTS");

await executeEffectsModuleBundle({
  manifestPath,
  grantPath,
  outputDirectory,
  execute: async () => {
    const current = Number(
      await readFile(counterPath, "utf8").catch(() => "0"),
    );
    await writeFile(counterPath, String(current + 1));
    process.kill(process.pid, "SIGKILL");
    return await new Promise<never>(() => undefined);
  },
});
