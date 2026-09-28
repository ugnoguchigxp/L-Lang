import { saveInventory } from "./paper-evidence";
import { evaluatePaper } from "./paper-evaluate";
import { reproducePaper } from "./paper-reproduce";
import {
  resumeStudy,
  runStudy,
  saveStudyReview,
  saveStudyValidation,
} from "./paper-study";
import { savePaperReport } from "./paper-report";

function options(args: string[], required: string[]) {
  const found: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !required.includes(key) ||
      !value ||
      value.startsWith("--") ||
      Object.hasOwn(found, key)
    )
      throw new Error("invalid option");
    found[key] = value;
  }
  for (const key of required)
    if (!found[key]) throw new Error(`missing ${key}`);
  return found;
}
export async function runPaperCli(args: string[]) {
  const [command, ...rest] = args;
  if (command === "help" || command === "--help") {
    if (rest.length) throw new Error("help takes no options");
    return {
      exitCode: 0,
      result: {
        commands: [
          "inventory",
          "reproduce",
          "evaluate",
          "validate-study",
          "review-study",
          "run-study",
          "resume-study",
          "report",
        ],
      },
    };
  }
  if (command === "inventory") {
    const o = options(rest, ["--input", "--out-dir"]);
    const result = await saveInventory(
      o["--input"] as string,
      o["--out-dir"] as string,
    );
    return { exitCode: result.inventory.diagnostics.length ? 1 : 0, result };
  }
  if (command === "reproduce") {
    const o = options(rest, ["--inventory", "--out-dir"]);
    const result = await reproducePaper(
      o["--inventory"] as string,
      o["--out-dir"] as string,
    );
    return {
      exitCode: result.status === "pass" ? 0 : result.status === "fail" ? 1 : 2,
      result,
    };
  }
  if (command === "evaluate") {
    const o = options(rest, ["--inventory", "--oracle", "--out-dir"]);
    const result = await evaluatePaper(
      o["--inventory"] as string,
      o["--oracle"] as string,
      o["--out-dir"] as string,
    );
    return { exitCode: result.status === "pass" ? 0 : 1, result };
  }
  if (command === "validate-study") {
    const o = options(rest, ["--study", "--out-dir"]);
    const result = await saveStudyValidation(
      o["--study"] as string,
      o["--out-dir"] as string,
    );
    return { exitCode: result.diagnostics.length ? 1 : 0, result };
  }
  if (command === "review-study") {
    const o = options(rest, ["--study", "--out-dir"]);
    const result = await saveStudyReview(
      o["--study"] as string,
      o["--out-dir"] as string,
    );
    return { exitCode: result.diagnostics.length ? 1 : 0, result };
  }
  if (command === "run-study") {
    const modeIndex = rest.indexOf("--mode");
    const mode = modeIndex < 0 ? null : rest[modeIndex + 1];
    if (mode !== "fixture" && mode !== "live")
      throw new Error("missing or invalid --mode");
    const approvalIndex = rest.indexOf("--approval");
    const approval = approvalIndex < 0 ? undefined : rest[approvalIndex + 1];
    const filtered = rest.filter(
      (_, i) =>
        (modeIndex < 0 || (i !== modeIndex && i !== modeIndex + 1)) &&
        (approvalIndex < 0 || (i !== approvalIndex && i !== approvalIndex + 1)),
    );
    const o = options(filtered, ["--study", "--out-dir"]);
    if (mode === "fixture" && approval)
      throw new Error("fixture must not use live approval");
    const result = await runStudy(
      o["--study"] as string,
      mode,
      o["--out-dir"] as string,
      approval,
    );
    return { exitCode: result.status === "complete" ? 0 : 2, result };
  }
  if (command === "resume-study") {
    const o = options(rest, ["--run-dir"]);
    const result = await resumeStudy(o["--run-dir"] as string);
    return { exitCode: result.status === "complete" ? 0 : 2, result };
  }
  if (command === "report") {
    const o = options(rest, ["--run-dir", "--out-dir"]);
    const result = await savePaperReport(
      o["--run-dir"] as string,
      o["--out-dir"] as string,
    );
    return { exitCode: 0, result };
  }
  throw new Error(
    "usage: paper-cli <inventory|reproduce|evaluate|validate-study|review-study|run-study|resume-study|report> [required options]",
  );
}
if (import.meta.main) {
  try {
    const { exitCode, result } = await runPaperCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
