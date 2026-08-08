import { describe, expect, test } from "bun:test";

import { normalizeSemanticError, semanticErrorJson } from "./semantic-error";

describe("structured semantic errors", () => {
  test("classifies stable input, transaction, and replay codes", () => {
    expect(
      normalizeSemanticError(new Error("fixture exceeds 10 bytes")).code,
    ).toBe("SEMANTIC_INPUT_LIMIT");
    expect(
      normalizeSemanticError(new Error("semantic workspace-busy")).code,
    ).toBe("SEMANTIC_WORKSPACE_BUSY");
    expect(
      normalizeSemanticError(new Error("replay failed: no lock entry")).code,
    ).toBe("SEMANTIC_REPLAY_MISS");
    for (const message of [
      "semantic command and target are required",
      "build does not accept duplicate --fixture",
      "--samples requires an integer",
      "--quorum cannot exceed --samples",
    ]) {
      expect(normalizeSemanticError(new Error(message)).code).toBe(
        "SEMANTIC_USAGE",
      );
    }
  });

  test("redacts credentials and renders a versioned JSON contract", () => {
    const error = normalizeSemanticError(
      new Error("authorization: sk-secretcredential123"),
    );
    expect(error.message).not.toContain("secretcredential");
    expect(semanticErrorJson(error)).toMatchObject({
      version: 1,
      error: {
        code: "SEMANTIC_INTERNAL",
        stage: "internal",
        remediation: expect.any(String),
      },
    });
  });

  test("redacts complete bearer and API-key credential values", () => {
    for (const message of [
      "Authorization: Bearer secret-bearer-token",
      "authorization=Basic dXNlcjpwYXNzd29yZA==",
      "api-key: secret-api-key-value",
    ]) {
      const error = normalizeSemanticError(new Error(message));
      expect(error.message).not.toContain("secret");
      expect(error.message).not.toContain("dXNlcjpwYXNzd29yZA");
      expect(error.message).toContain("[REDACTED]");
    }
  });
});
