import { readFile } from "node:fs/promises";
import { LLANG_HELP } from "./llang-cli";

const [reference, quality, workflow, packageText] = await Promise.all(
  [
    "docs/LLANG_CLI_REFERENCE.md",
    "QUALITY_GATES.md",
    ".github/workflows/ci.yml",
    "package.json",
  ].map((path) => readFile(path, "utf8")),
);
const pkg = JSON.parse(packageText ?? "{}");
const commands = [...LLANG_HELP.matchAll(/^ {2}([a-z-]+) </gm)].map(
  (match) => match[1],
);
const moduleCommands = [
  ...LLANG_HELP.matchAll(/^ {2}module ([a-z-]+) </gm),
].map((match) => `module ${match[1]}`);
for (const command of [...commands, ...moduleCommands]) {
  if (!reference?.includes(`| ${command} |`))
    throw new Error(`CLI reference missing command: ${command}`);
}
const bun = pkg.packageManager.replace(/^bun@/, "");
const versions = [
  bun,
  pkg.devDependencies.typescript,
  pkg.devDependencies["@biomejs/biome"],
];
for (const version of versions)
  if (!quality?.includes(version))
    throw new Error(`quality guide missing configured version: ${version}`);
const ciVersions = [
  ...(workflow ?? "").matchAll(/bun-version:\s*([^\s]+)/g),
].map((match) => match[1]);
if (!ciVersions.length || ciVersions.some((version) => version !== bun))
  throw new Error("CI Bun version differs from packageManager");
if (!pkg.scripts["ci:smoke"].includes("ci:llang-smoke"))
  throw new Error("JSONC smoke is not included in CI smoke");
if (!pkg.scripts["ci:smoke"].includes("ci:module-smoke"))
  throw new Error("typed module smoke is not included in CI smoke");
console.log(
  `documentation contracts passed: ${commands.length + moduleCommands.length} commands, ${versions.length} versions, JSONC and module smoke`,
);
