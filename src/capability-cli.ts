import {
  inspectCapability,
  packageCapability,
  verifyCapability,
  writeCapabilityReport,
} from "./capability-package";
import { invalid } from "./capability-tests";
import { readJson } from "./prompt-source";

export async function runCapabilityCli(args: string[]) {
  const [command, path, ...rest] = args;
  if (!path) invalid("expected capability package|verify|inspect <path>");
  const allowed =
    command === "package"
      ? ["--tests", "--metadata", "--out-dir"]
      : command === "verify"
        ? ["--report"]
        : command === "inspect"
          ? ["--json"]
          : [];
  if (!["package", "verify", "inspect"].includes(command ?? ""))
    invalid("unknown command");
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i] as string;
    if (!allowed.includes(key) || Object.hasOwn(options, key))
      invalid("unknown or duplicate option");
    if (key === "--json") options[key] = "true";
    else {
      const value = rest[++i];
      if (!value || value.startsWith("--")) invalid(`missing ${key} value`);
      options[key] = value;
    }
  }
  const required = (key: string) => options[key] ?? invalid(`missing ${key}`);
  if (command === "package")
    return {
      exitCode: 0,
      result: await packageCapability(
        path,
        required("--tests"),
        await readJson(required("--metadata")),
        required("--out-dir"),
      ),
    };
  if (command === "inspect")
    return { exitCode: 0, result: await inspectCapability(path) };
  const reportPath = required("--report");
  const result = await verifyCapability(path);
  await writeCapabilityReport(reportPath, result, path);
  return {
    exitCode: result.status === "pass" ? 0 : result.status === "fail" ? 1 : 2,
    result,
  };
}
if (import.meta.main) {
  try {
    const { exitCode, result } = await runCapabilityCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = exitCode;
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "error",
        acceptance: "not-run",
        diagnostics: [error instanceof Error ? error.message : String(error)],
      }),
    );
    process.exitCode = 2;
  }
}
