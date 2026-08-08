import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type ResolveContainedFileOptions = {
  containmentLabel?: string;
  rejectSymbolicLinks?: boolean;
};

export async function resolveContainedFile(
  rootPath: string,
  inputPath: string,
  label: string,
  options: ResolveContainedFileOptions = {},
): Promise<string> {
  const containmentLabel = options.containmentLabel ?? "workspace root";
  const lexicalRoot = resolve(rootPath);
  const lexicalTarget = resolve(lexicalRoot, inputPath);
  const lexicalRelative = containedRelativePath(
    lexicalRoot,
    lexicalTarget,
    label,
    containmentLabel,
  );
  const canonicalRoot = await realpath(lexicalRoot);
  const canonicalTarget = await realpath(lexicalTarget);
  containedRelativePath(
    canonicalRoot,
    canonicalTarget,
    label,
    containmentLabel,
  );

  if (
    options.rejectSymbolicLinks === true &&
    resolve(canonicalRoot, lexicalRelative) !== canonicalTarget
  ) {
    throw new Error(`${label} must not use a symbolic link`);
  }
  if (!(await stat(canonicalTarget)).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return canonicalTarget;
}

export function containedRelativePath(
  rootPath: string,
  targetPath: string,
  label: string,
  containmentLabel = "workspace root",
): string {
  const relation = relative(resolve(rootPath), resolve(targetPath)).replaceAll(
    "\\",
    "/",
  );
  if (
    relation === ".." ||
    relation.startsWith("../") ||
    isAbsolute(relation)
  ) {
    throw new Error(`${label} must resolve inside the ${containmentLabel}`);
  }
  return relation;
}
