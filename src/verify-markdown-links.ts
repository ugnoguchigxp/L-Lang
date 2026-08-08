import { readdir, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".semantic",
  "artifacts",
  "node_modules",
]);

export async function verifyMarkdownLinks(root = process.cwd()): Promise<void> {
  const markdownFiles = await findMarkdownFiles(root);
  const failures: string[] = [];
  for (const markdownFile of markdownFiles) {
    const text = await Bun.file(markdownFile).text();
    for (const target of markdownTargets(text)) {
      const localPath = localLinkPath(root, markdownFile, target);
      if (localPath === undefined) continue;
      try {
        await stat(localPath);
      } catch (error) {
        if (isNotFound(error)) {
          failures.push(`${markdownFile}: missing link target ${target}`);
          continue;
        }
        throw error;
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Markdown link verification failed:\n${failures.join("\n")}`,
    );
  }
}

async function findMarkdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(
          ...(await findMarkdownFiles(resolve(directory, entry.name))),
        );
      }
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      files.push(resolve(directory, entry.name));
    }
  }
  return files.sort();
}

function markdownTargets(text: string): string[] {
  const targets: string[] = [];
  const inline = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/gu;
  const reference = /^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gmu;
  for (const match of text.matchAll(inline)) {
    if (match[1] !== undefined) targets.push(unquoteTarget(match[1]));
  }
  for (const match of text.matchAll(reference)) {
    if (match[1] !== undefined) targets.push(unquoteTarget(match[1]));
  }
  return targets;
}

function localLinkPath(
  root: string,
  markdownFile: string,
  target: string,
): string | undefined {
  if (
    target.length === 0 ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
  ) {
    return undefined;
  }
  const withoutFragment = target.split(/[?#]/u, 1)[0];
  if (withoutFragment === undefined || withoutFragment.length === 0) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    throw new Error(
      `${markdownFile}: link target is not valid URI text: ${target}`,
    );
  }
  return decoded.startsWith("/")
    ? resolve(root, decoded.slice(1))
    : resolve(dirname(markdownFile), decoded);
}

function unquoteTarget(target: string): string {
  return target.startsWith("<") && target.endsWith(">")
    ? target.slice(1, -1)
    : target;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

if (import.meta.main) {
  await verifyMarkdownLinks();
  console.log("Markdown links verified");
}
