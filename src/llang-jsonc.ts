import { TextDecoder } from "node:util";
import {
  type Node,
  type ParseError,
  SyntaxKind,
  createScanner,
  findNodeAtLocation,
  format,
  getNodeValue,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import {
  LLANG_DIAGNOSTIC_LIMIT,
  type LlangDiagnostic,
  pointer,
  reportFor,
  sourceRange,
} from "./llang-diagnostics";
import { digest } from "./wasm-contract";
import { stableJson } from "./stable-hash";

export const LLANG_SOURCE_BYTES = 1024 * 1024;
export const LLANG_JSON_DEPTH = 64;

export type LlangJsoncDocument = {
  text: string;
  file: string;
  root: Node;
  value: unknown;
  sourceHash: string;
};

export type LlangJsoncResult = {
  document?: LlangJsoncDocument;
  report: ReturnType<typeof reportFor>;
};

function diagnostic(
  text: string,
  file: string,
  code: string,
  message: string,
  offset = 0,
  length = 1,
  path = "",
): LlangDiagnostic {
  return {
    code,
    severity: "error",
    message,
    file,
    range: sourceRange(text, offset, length),
    path,
    related: [],
  };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function checkTree(
  text: string,
  file: string,
  node: Node,
  diagnostics: LlangDiagnostic[],
  path: (string | number)[] = [],
  depth = 1,
): void {
  if (diagnostics.length > LLANG_DIAGNOSTIC_LIMIT) return;
  if (depth > LLANG_JSON_DEPTH) {
    diagnostics.push(
      diagnostic(
        text,
        file,
        "LLJ003",
        `JSONC depth exceeds ${LLANG_JSON_DEPTH}`,
        node.offset,
        node.length,
        pointer(path),
      ),
    );
    return;
  }
  if (node.type === "object") {
    const seen = new Map<string, { node: Node; path: string }>();
    for (const property of node.children ?? []) {
      if (diagnostics.length > LLANG_DIAGNOSTIC_LIMIT) break;
      const [keyNode, valueNode] = property.children ?? [];
      if (!keyNode || !valueNode) continue;
      const key = String(getNodeValue(keyNode));
      const propertyPath = [...path, key];
      if (hasUnpairedSurrogate(key))
        diagnostics.push(
          diagnostic(
            text,
            file,
            "LLJ003",
            "key contains an unpaired Unicode surrogate",
            keyNode.offset,
            keyNode.length,
            pointer(propertyPath),
          ),
        );
      const prior = seen.get(key);
      if (prior) {
        const item = diagnostic(
          text,
          file,
          "LLJ002",
          `duplicate key ${JSON.stringify(key)}`,
          keyNode.offset,
          keyNode.length,
          pointer(propertyPath),
        );
        item.related.push({
          message: "first key is here",
          range: sourceRange(text, prior.node.offset, prior.node.length),
          path: prior.path,
        });
        diagnostics.push(item);
      } else seen.set(key, { node: keyNode, path: pointer(propertyPath) });
      checkTree(text, file, valueNode, diagnostics, propertyPath, depth + 1);
    }
  } else if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries()) {
      if (diagnostics.length > LLANG_DIAGNOSTIC_LIMIT) break;
      checkTree(text, file, child, diagnostics, [...path, index], depth + 1);
    }
  } else if (node.type === "number" && !Number.isFinite(getNodeValue(node))) {
    diagnostics.push(
      diagnostic(
        text,
        file,
        "LLJ001",
        "number must be finite",
        node.offset,
        node.length,
        pointer(path),
      ),
    );
  } else if (node.type === "string") {
    const value = String(getNodeValue(node));
    if (hasUnpairedSurrogate(value))
      diagnostics.push(
        diagnostic(
          text,
          file,
          "LLJ003",
          "string contains an unpaired Unicode surrogate",
          node.offset,
          node.length,
          pointer(path),
        ),
      );
  }
}

function checkDepth(
  text: string,
  file: string,
  diagnostics: LlangDiagnostic[],
): void {
  const scanner = createScanner(text, false);
  let depth = 0;
  for (;;) {
    const token = scanner.scan();
    if (token === SyntaxKind.EOF) return;
    if (
      token === SyntaxKind.OpenBraceToken ||
      token === SyntaxKind.OpenBracketToken
    ) {
      depth++;
      if (depth > LLANG_JSON_DEPTH) {
        diagnostics.push(
          diagnostic(
            text,
            file,
            "LLJ003",
            `JSONC depth exceeds ${LLANG_JSON_DEPTH}`,
            scanner.getTokenOffset(),
            scanner.getTokenLength(),
          ),
        );
        return;
      }
    } else if (
      token === SyntaxKind.CloseBraceToken ||
      token === SyntaxKind.CloseBracketToken
    )
      depth = Math.max(0, depth - 1);
  }
}

export function parseLlangJsonc(
  text: string,
  file = "<input>",
): LlangJsoncResult {
  const diagnostics: LlangDiagnostic[] = [];
  if (Buffer.byteLength(text) > LLANG_SOURCE_BYTES)
    diagnostics.push(
      diagnostic(
        text,
        file,
        "LLJ003",
        `source exceeds ${LLANG_SOURCE_BYTES} bytes`,
      ),
    );
  if (text.charCodeAt(0) === 0xfeff)
    diagnostics.push(
      diagnostic(text, file, "LLJ003", "UTF-8 BOM is not allowed"),
    );
  checkDepth(text, file, diagnostics);
  if (diagnostics.some((item) => item.code === "LLJ003"))
    return { report: reportFor(diagnostics) };
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  for (const error of errors.slice(0, LLANG_DIAGNOSTIC_LIMIT + 1))
    diagnostics.push(
      diagnostic(
        text,
        file,
        "LLJ001",
        `invalid JSONC: ${printParseErrorCode(error.error)}`,
        error.offset,
        error.length,
      ),
    );
  if (root && root.type !== "object")
    diagnostics.push(
      diagnostic(
        text,
        file,
        "LLJ001",
        "JSONC root must be an object",
        root.offset,
        root.length,
      ),
    );
  if (root) checkTree(text, file, root, diagnostics);
  const report = reportFor(diagnostics);
  if (!root || !report.ok) return { report };
  return {
    document: {
      text,
      file,
      root,
      value: getNodeValue(root),
      sourceHash: digest(new TextEncoder().encode(text)),
    },
    report,
  };
}

export function nodeForPath(
  document: LlangJsoncDocument,
  path: readonly (string | number)[],
): Node {
  return findNodeAtLocation(document.root, [...path]) ?? document.root;
}

export function rangeForPath(
  document: LlangJsoncDocument,
  path: readonly (string | number)[],
) {
  const node = nodeForPath(document, path);
  return sourceRange(document.text, node.offset, node.length);
}

export function formatLlangJsonc(text: string, file = "<input>") {
  const parsed = parseLlangJsonc(text, file);
  if (!parsed.document) return { text, report: parsed.report };
  const edits = format(text, undefined, {
    insertSpaces: true,
    tabSize: 2,
    eol: "\n",
    insertFinalNewline: true,
    keepLines: false,
  });
  let output = text;
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset))
    output = `${output.slice(0, edit.offset)}${edit.content}${output.slice(edit.offset + edit.length)}`;
  const checked = parseLlangJsonc(output, file);
  if (!checked.document) throw new Error("formatter produced invalid JSONC");
  if (stableJson(checked.document.value) !== stableJson(parsed.document.value))
    throw new Error("formatter changed the JSONC value");
  return { text: output, report: parsed.report };
}

export function decodeUtf8(bytes: Uint8Array, file: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${file} must contain valid UTF-8`);
  }
}

export function parseStrictJsonObject(text: string, file = "<input>"): unknown {
  if (Buffer.byteLength(text) > LLANG_SOURCE_BYTES)
    throw new Error(`${file} exceeds ${LLANG_SOURCE_BYTES} bytes`);
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${file} must contain standard JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseLlangJsonc(text, file);
  if (!parsed.document)
    throw new Error(
      `${file} contains ambiguous or invalid JSON: ${parsed.report.diagnostics
        .map((item) => `${item.code} ${item.path || "/"}: ${item.message}`)
        .join("; ")}`,
    );
  return parsed.document.value;
}
