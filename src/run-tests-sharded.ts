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

const shardSize = 24;
for (let offset = 0; offset < files.length; offset += shardSize) {
  const shard = files.slice(offset, offset + shardSize);
  const number = Math.floor(offset / shardSize) + 1;
  const count = Math.ceil(files.length / shardSize);
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
