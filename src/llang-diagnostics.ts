export type SourcePosition = { line: number; column: number; offset: number };

export type SourceRange = {
  start: SourcePosition;
  end: SourcePosition;
};

export type LlangDiagnostic = {
  code: string;
  severity: "error" | "warning";
  message: string;
  file: string;
  range: SourceRange;
  path: string;
  related: { message: string; range: SourceRange; path: string }[];
  hint?: string;
};

export type LlangDiagnosticReport = {
  version: 1;
  ok: boolean;
  diagnostics: LlangDiagnostic[];
  truncated: boolean;
};

export const LLANG_DIAGNOSTIC_LIMIT = 32;

export function positionAt(text: string, offset: number): SourcePosition {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < bounded; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: bounded - lineStart + 1, offset: bounded };
}

export function sourceRange(
  text: string,
  offset: number,
  length: number,
): SourceRange {
  return {
    start: positionAt(text, offset),
    end: positionAt(text, offset + Math.max(1, length)),
  };
}

export function pointer(segments: readonly (string | number)[]): string {
  if (!segments.length) return "";
  return segments
    .map((segment) =>
      String(segment).replaceAll("~", "~0").replaceAll("/", "~1"),
    )
    .map((segment) => `/${segment}`)
    .join("");
}

export function reportFor(
  diagnostics: LlangDiagnostic[],
): LlangDiagnosticReport {
  const normalized = diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: diagnostic.message.slice(0, 2000),
    ...(diagnostic.hint ? { hint: diagnostic.hint.slice(0, 2000) } : {}),
  }));
  const sorted = normalized.sort(
    (a, b) =>
      a.range.start.offset - b.range.start.offset ||
      a.code.localeCompare(b.code),
  );
  const truncated = sorted.length > LLANG_DIAGNOSTIC_LIMIT;
  const selected = sorted.slice(0, LLANG_DIAGNOSTIC_LIMIT);
  return {
    version: 1,
    ok: !sorted.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics: selected,
    truncated,
  };
}
