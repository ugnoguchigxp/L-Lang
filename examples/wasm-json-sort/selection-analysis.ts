// Only generated Binaryen text is accepted here, not arbitrary user WAT.
function endOfExpression(text: string, start: number): number {
  if (text[start] !== "(") throw new Error("Expected generated expression");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return i + 1;
  }
  throw new Error("Unbalanced generated expression");
}

export function selectionFunction(wat: string, exportName: string) {
  const entry = wat.match(
    new RegExp(`\\(export "${exportName}" \\(func ([^)]+)\\)\\)`),
  );
  let name = entry?.[1];
  if (!name) throw new Error("Missing selection export");
  // An unoptimized module has a trivial exported wrapper around the algorithm.
  for (let depth = 0; depth < 3; depth++) {
    const start = wat.indexOf(`(func ${name} `);
    if (start < 0) throw new Error("Missing generated function");
    const end = endOfExpression(wat, start);
    const text = wat.slice(start, end);
    if (text.includes("(loop ")) return { name, start, end, text };
    const calls = [...text.matchAll(/\(call ([^\s()]+)/g)];
    if (calls.length !== 1 || !calls[0]?.[1])
      throw new Error("Unexpected selection wrapper");
    name = calls[0][1];
  }
  throw new Error("Selection wrapper depth exceeded");
}

export function analyzeSelection(wat: string, exportName: string) {
  const { text } = selectionFunction(wat, exportName);
  return {
    // Static occurrences, not dynamic instruction counts or native assembly.
    select: (text.match(/\(select\s/g) ?? []).length,
    load: (text.match(/\(i32\.load\s/g) ?? []).length,
    calls: (text.match(/\(call\s/g) ?? []).length,
    if: (text.match(/\(if\s/g) ?? []).length,
  };
}

export function restoreSelectionBranch(
  wat: string,
  exportName: string,
): string {
  const fn = selectionFunction(wat, exportName);
  // Rewrite only x = select(local y, local x, condition). Both value arms are
  // pure local reads; condition is still evaluated exactly once. No speculative
  // memory access, trap semantics, or another algorithm's select is changed.
  const pattern =
    /\(local\.set (\$[^\s()]+)\s+\(select\s+(\(local\.get \$[^\s()]+\))\s+\(local\.get (\$[^\s()]+)\)\s+/g;
  const matches = [...fn.text.matchAll(pattern)].filter((m) => m[1] === m[3]);
  const match = matches[0];
  if (matches.length !== 1 || !match || match.index === undefined)
    throw new Error("Expected exactly one safe selection update");
  const conditionStart = match.index + match[0].length;
  const conditionEnd = endOfExpression(fn.text, conditionStart);
  const assignmentEnd = endOfExpression(fn.text, match.index);
  if (!/^\s*\)\s*\)$/.test(fn.text.slice(conditionEnd, assignmentEnd)))
    throw new Error("Unexpected selection operands");
  const replacement = `(if ${fn.text.slice(conditionStart, conditionEnd)} (then (local.set ${match[1]} ${match[2]})))`;
  const transformed =
    fn.text.slice(0, match.index) + replacement + fn.text.slice(assignmentEnd);
  return wat.slice(0, fn.start) + transformed + wat.slice(fn.end);
}
