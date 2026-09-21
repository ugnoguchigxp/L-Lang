export {};

const listing = Bun.spawn(
  [
    "git",
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*.test.ts",
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  },
);
const listedFiles = (await new Response(listing.stdout).text())
  .split(/\r?\n/u)
  .filter(Boolean)
  .sort();
if ((await listing.exited) !== 0 || listedFiles.length === 0)
  throw new Error("cannot list test files");
const priority = ["src/effects-adversarial-benchmark.test.ts"],
  files = [
    ...priority.filter((file) => listedFiles.includes(file)),
    ...listedFiles.filter((file) => !priority.includes(file)),
  ];

const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "--coverage",
    "--timeout",
    "30000",
    "--max-concurrency",
    "1",
    ...files,
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  },
);
const [stdout, stderr, exitCode] = await Promise.all([
  capture(child.stdout, process.stdout),
  capture(child.stderr, process.stderr),
  child.exited,
]);

if (exitCode !== 0) process.exit(exitCode);

const coverage = `${stdout}\n${stderr}`;
enforceCoverage(coverage, /^All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/m, {
  label: "overall",
  minimumFunctions: 90,
  minimumLines: 90,
});
enforceCoverage(
  coverage,
  /^\s*src[\\/]semantic-transaction\.ts\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/m,
  {
    label: "semantic-transaction.ts",
    minimumFunctions: 95,
    minimumLines: 95,
  },
);
console.log("coverage thresholds passed");

function enforceCoverage(
  report: string,
  pattern: RegExp,
  input: {
    label: string;
    minimumFunctions: number;
    minimumLines: number;
  },
): void {
  const match = report.match(pattern);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`coverage row missing for ${input.label}`);
  }
  const functions = Number(match[1]);
  const lines = Number(match[2]);
  if (
    !Number.isFinite(functions) ||
    !Number.isFinite(lines) ||
    functions < input.minimumFunctions ||
    lines < input.minimumLines
  ) {
    throw new Error(
      `${input.label} coverage is ${functions}% functions / ${lines}% lines; required ${input.minimumFunctions}% / ${input.minimumLines}%`,
    );
  }
}

async function capture(
  stream: ReadableStream<Uint8Array>,
  output: NodeJS.WriteStream,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    output.write(chunk);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
