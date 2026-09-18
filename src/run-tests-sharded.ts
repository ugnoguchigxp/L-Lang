export {};

const listing = Bun.spawn(["git", "ls-files", "--", "*.test.ts"], {
  cwd: process.cwd(),
  env: process.env,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "inherit",
});
const files = (await new Response(listing.stdout).text())
  .split(/\r?\n/u)
  .filter(Boolean)
  .sort();
if ((await listing.exited) !== 0) throw new Error("cannot list test files");
if (files.length === 0) throw new Error("no test files found");

const isolated = new Set(["src/static-judgment-compiler.integration.test.ts"]);
const regularFiles = files.filter((file) => !isolated.has(file));
const shardSize = 24;
const shards: string[][] = [];
for (let offset = 0; offset < regularFiles.length; offset += shardSize)
  shards.push(regularFiles.slice(offset, offset + shardSize));
for (const file of files) if (isolated.has(file)) shards.push([file]);

for (const [index, shard] of shards.entries()) {
  const number = index + 1;
  const count = shards.length;
  console.log(`test shard ${number}/${count} (${shard.length} files)`);
  const child = Bun.spawn(
    [process.execPath, "test", "--timeout", "30000", ...shard],
    {
      cwd: process.cwd(),
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
