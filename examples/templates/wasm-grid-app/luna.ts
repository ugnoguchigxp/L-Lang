import { Codex } from "@openai/codex-sdk";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Explicitly invoked generation tooling; never part of an app's dist. */
export async function runLuna(options: {
  workspace: string;
  prompt: string;
  recordDir: string;
  phase: string;
  reasoning: "low" | "medium";
  resume?: boolean;
}) {
  const dir = resolve(options.recordDir);
  if (!/^[a-z0-9-]+$/.test(options.phase))
    throw new Error("Invalid phase name");
  await mkdir(dir, { recursive: true });
  if (await Bun.file(join(dir, `${options.phase}-events.jsonl`)).exists())
    throw new Error("Phase recording already exists; use a new phase name");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        ![
          "OPENAI_API_KEY",
          "OPENAI_BASE_URL",
          "AZURE_OPENAI_API_KEY",
          "CODEX_API_KEY",
        ].includes(key),
    ),
  ) as Record<string, string>;
  const codex = new Codex({
    env,
    configOverrides: ["mcp_servers={}", "plugins={}"],
    config: {
      features: {
        shell_tool: true,
        unified_exec: true,
        multi_agent: false,
        apps: false,
        image_generation: false,
      },
      project_doc_max_bytes: 0,
    },
  });
  const threadOptions = {
    model: "gpt-5.6-luna",
    modelReasoningEffort: options.reasoning,
    workingDirectory: resolve(options.workspace),
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write" as const,
    approvalPolicy: "never" as const,
    networkAccessEnabled: false,
    webSearchMode: "disabled" as const,
  };
  const idPath = join(dir, "thread-id.txt");
  const thread = options.resume
    ? codex.resumeThread((await readFile(idPath, "utf8")).trim(), threadOptions)
    : codex.startThread(threadOptions);
  const started = Date.now();
  let sdkUsage: unknown = null,
    completed = false;
  await writeFile(join(dir, `${options.phase}-prompt.txt`), options.prompt);
  const stream = await thread.runStreamed(options.prompt);
  for await (const event of stream.events) {
    await appendFile(
      join(dir, `${options.phase}-events.jsonl`),
      `${JSON.stringify(event)}\n`,
    );
    if (event.type === "thread.started")
      await writeFile(idPath, event.thread_id);
    if (event.type === "item.completed" && event.item.type === "agent_message")
      console.log(event.item.text);
    if (event.type === "turn.completed") {
      sdkUsage = event.usage;
      completed = true;
    }
    if (event.type === "turn.failed" || event.type === "error")
      console.log(JSON.stringify(event));
  }
  const threadId = (await readFile(idPath, "utf8")).trim();
  let rawUsage: unknown = null,
    actualModel: string | null = null;
  for await (const path of new Bun.Glob(`**/*${threadId}*.jsonl`).scan({
    cwd: join(homedir(), ".codex/sessions"),
    absolute: true,
  })) {
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "turn_context") actualModel = event.payload.model;
      if (
        event.type === "event_msg" &&
        event.payload.type === "token_count" &&
        event.payload.info?.total_token_usage
      )
        rawUsage = event.payload.info.total_token_usage;
    }
  }
  const record = {
    phase: options.phase,
    threadId,
    requestedModel: threadOptions.model,
    actualModel,
    reasoning: options.reasoning,
    completed,
    elapsedMs: Date.now() - started,
    sdkUsage,
    rawCumulativeUsage: rawUsage,
  };
  await writeFile(
    join(dir, `${options.phase}-usage.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.log(JSON.stringify(record));
  if (!completed)
    throw new Error("Luna generation turn failed; inspect retained events");
  if (actualModel !== threadOptions.model || !rawUsage)
    throw new Error("Model/usage audit unavailable; do not infer consumption");
  return record;
}
if (import.meta.main) {
  const [workspace, promptPath, recordDir, phase, reasoning, resume] =
    process.argv.slice(2);
  if (
    !workspace ||
    !promptPath ||
    !recordDir ||
    !phase ||
    (reasoning !== "low" && reasoning !== "medium")
  )
    throw new Error(
      "Usage: luna.ts workspace prompt.md recordDir phase low|medium [--resume]",
    );
  await runLuna({
    workspace,
    prompt: await readFile(promptPath, "utf8"),
    recordDir,
    phase,
    reasoning,
    resume: resume === "--resume",
  });
}
