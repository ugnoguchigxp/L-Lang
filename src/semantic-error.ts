export type SemanticErrorCode =
  | "SEMANTIC_USAGE"
  | "SEMANTIC_INVALID_INPUT"
  | "SEMANTIC_INPUT_LIMIT"
  | "SEMANTIC_UNRESOLVED"
  | "SEMANTIC_REPLAY_MISS"
  | "SEMANTIC_WORKSPACE_BUSY"
  | "SEMANTIC_CONFLICT"
  | "SEMANTIC_MANUAL_RECOVERY"
  | "SEMANTIC_VALIDATION_FAILED"
  | "SEMANTIC_IO"
  | "SEMANTIC_INTERNAL";

export type SemanticErrorStage =
  | "arguments"
  | "input"
  | "resolution"
  | "validation"
  | "transaction"
  | "io"
  | "internal";

export class SemanticError extends Error {
  readonly code: SemanticErrorCode;
  readonly stage: SemanticErrorStage;
  readonly remediation: string;

  constructor(input: {
    code: SemanticErrorCode;
    stage: SemanticErrorStage;
    message: string;
    remediation: string;
    cause?: unknown;
  }) {
    super(sanitizeSemanticMessage(input.message), {
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    });
    this.name = "SemanticError";
    this.code = input.code;
    this.stage = input.stage;
    this.remediation = input.remediation;
  }
}

export function normalizeSemanticError(error: unknown): SemanticError {
  if (error instanceof SemanticError) return error;
  const message = sanitizeSemanticMessage(
    error instanceof Error ? error.message : String(error),
  );
  const classified = classifyMessage(message);
  return new SemanticError({
    ...classified,
    message,
    cause: error,
  });
}

export function semanticErrorJson(error: SemanticError): {
  version: 1;
  error: {
    code: SemanticErrorCode;
    stage: SemanticErrorStage;
    message: string;
    remediation: string;
  };
} {
  return {
    version: 1,
    error: {
      code: error.code,
      stage: error.stage,
      message: error.message,
      remediation: error.remediation,
    },
  };
}

export function renderSemanticError(error: SemanticError): string {
  return [
    `error [${error.code}] (${error.stage}): ${error.message}`,
    `remediation: ${error.remediation}`,
  ].join("\n");
}

function classifyMessage(message: string): {
  code: SemanticErrorCode;
  stage: SemanticErrorStage;
  remediation: string;
} {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("usage:") ||
    normalized.includes("semantic command and target are required") ||
    normalized.includes("does not accept") ||
    normalized.includes("requires --reviewer") ||
    normalized.includes("requires a value") ||
    normalized.includes("requires an integer") ||
    normalized.includes("requires a safe integer") ||
    normalized.startsWith("--") ||
    normalized.includes("positional argument")
  ) {
    return {
      code: "SEMANTIC_USAGE",
      stage: "arguments",
      remediation: "Correct the command arguments and run the command again.",
    };
  }
  if (normalized.includes("manual-recovery-required")) {
    return {
      code: "SEMANTIC_MANUAL_RECOVERY",
      stage: "transaction",
      remediation:
        "Inspect the transaction journal and restore either the recorded previous or next artifact pair.",
    };
  }
  if (normalized.includes("workspace-busy")) {
    return {
      code: "SEMANTIC_WORKSPACE_BUSY",
      stage: "transaction",
      remediation:
        "Wait for the active semantic promotion to finish, then retry.",
    };
  }
  if (
    normalized.includes("transaction conflict") ||
    normalized.includes("baseline is stale") ||
    normalized.includes("candidate is stale")
  ) {
    return {
      code: "SEMANTIC_CONFLICT",
      stage: "transaction",
      remediation:
        "Rebuild or re-check the candidate from the current workspace state.",
    };
  }
  if (
    normalized.includes("exceeds") ||
    normalized.includes("depth limit") ||
    normalized.includes("node limit") ||
    normalized.includes("must contain at most")
  ) {
    return {
      code: "SEMANTIC_INPUT_LIMIT",
      stage: "input",
      remediation:
        "Reduce the input to the documented semantic resource limits.",
    };
  }
  if (
    normalized.includes("unresolved") ||
    normalized.includes("consensus not reached")
  ) {
    return {
      code: "SEMANTIC_UNRESOLVED",
      stage: "resolution",
      remediation:
        "Clarify the Concept or source schema, then resolve the semantic input again.",
    };
  }
  if (
    normalized.includes("replay failed") ||
    normalized.includes("no lock entry")
  ) {
    return {
      code: "SEMANTIC_REPLAY_MISS",
      stage: "resolution",
      remediation:
        "Run an approved build for the current semantic inputs before replaying.",
    };
  }
  if (
    normalized.includes("unknown field") ||
    normalized.includes("must contain valid json") ||
    normalized.includes("must contain exactly") ||
    normalized.includes("must be a")
  ) {
    return {
      code: "SEMANTIC_INVALID_INPUT",
      stage: "input",
      remediation:
        "Correct the malformed semantic input without adding unknown fields.",
    };
  }
  if (
    normalized.includes("enoent") ||
    normalized.includes("eacces") ||
    normalized.includes("file")
  ) {
    return {
      code: "SEMANTIC_IO",
      stage: "io",
      remediation:
        "Verify the workspace paths and file permissions, then retry.",
    };
  }
  if (
    normalized.includes("typecheck") ||
    normalized.includes("test failed") ||
    normalized.includes("validation") ||
    normalized.includes("integrity")
  ) {
    return {
      code: "SEMANTIC_VALIDATION_FAILED",
      stage: "validation",
      remediation:
        "Inspect the validation diagnostics and correct the candidate or source.",
    };
  }
  return {
    code: "SEMANTIC_INTERNAL",
    stage: "internal",
    remediation:
      "Inspect the audit report and rerun with the same inputs after correcting the reported cause.",
  };
}

function sanitizeSemanticMessage(message: string): string {
  return message
    .replace(
      /((?:api[-_ ]?key|authorization)\s*[:=]\s*)[^\r\n,;&]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, 2_000);
}
