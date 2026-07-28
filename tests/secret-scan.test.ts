import { describe, expect, it } from "vitest";

import { scanSecretBuffer, scanSecretText } from "../scripts/scan-secrets.mjs";

describe("static secret scan", () => {
  it("detects fixed-format provider credentials without printing their values", () => {
    expect(scanSecretText("OPENAI_API_KEY=sk-proj-qA9mZ2xK7vP4rT8nW6cD3fH5jL1sY0uB")) // secret-scan: allow-fixture
      .toEqual([{ line: 1, rule: "openai-api-key" }]);
    expect(scanSecretText("token: ghp_qA9mZ2xK7vP4rT8nW6cD3fH5jL1sY0uB")) // secret-scan: allow-fixture
      .toEqual(expect.arrayContaining([
        { line: 1, rule: "github-token" },
        { line: 1, rule: "high-entropy-secret-assignment" },
      ]));
  });

  it("detects private keys and high-entropy generic secret assignments", () => {
    expect(scanSecretText("-----BEGIN PRIVATE KEY-----")) // secret-scan: allow-fixture
      .toEqual([{ line: 1, rule: "private-key" }]);
    expect(scanSecretText("client_secret = 'q9Lx2mNv7pRs4tUw8yZa3bCd6eFg1hJk'")) // secret-scan: allow-fixture
      .toEqual([{ line: 1, rule: "high-entropy-secret-assignment" }]);
  });

  it("permits explicit placeholders and deterministic test fixtures", () => {
    expect(scanSecretText("API_KEY=replace-me-with-a-real-value")).toEqual([]);
    expect(scanSecretText("SESSION_SECRET=0123456789abcdef0123456789abcdef")).toEqual([]);
  });

  it("does not interpret binary files as source text", () => {
    expect(scanSecretBuffer(Buffer.from([1, 2, 0, 3, 4]))).toEqual([]);
  });
});
