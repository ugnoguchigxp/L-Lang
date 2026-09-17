export {};

const child = Bun.spawn(["bun", "test", "--coverage", "--timeout", "30000"], {
  cwd: process.cwd(),
  env: process.env,
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
process.stdout.write(stdout);
process.stderr.write(stderr);
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
