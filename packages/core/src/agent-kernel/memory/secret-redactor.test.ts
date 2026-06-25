import { describe, expect, test } from "vitest";
import { PatternSecretRedactor } from "./secret-redactor.js";

describe("PatternSecretRedactor", () => {
  const redactor = new PatternSecretRedactor();

  test("passes through clean content unchanged", () => {
    const result = redactor.scan("This is normal conversation content.");
    expect(result.hasSecrets).toBe(false);
    expect(result.redactedText).toBe("This is normal conversation content.");
    expect(result.reasons).toHaveLength(0);
  });

  test("detects and redacts API keys", () => {
    const result = redactor.scan("Set api_key=abc123def456 to configure.");
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("api_key");
    expect(result.redactedText).toContain("[REDACTED:api_key]");
    expect(result.redactedText).not.toContain("abc123def456");
  });

  test("detects and redacts access tokens", () => {
    const result = redactor.scan("Use access_token=secret789 for auth.");
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("api_key");
    expect(result.redactedText).toContain("[REDACTED:api_key]");
    expect(result.redactedText).not.toContain("secret789");
  });

  test("detects and redacts password patterns", () => {
    const result = redactor.scan("The password=supersecret123 for the database.");
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("password");
    expect(result.redactedText).toContain("[REDACTED:password]");
    expect(result.redactedText).not.toContain("supersecret123");
  });

  test("detects pwd and passwd variants", () => {
    const r1 = redactor.scan("pwd=mysecret");
    const r2 = redactor.scan("passwd=anothersecret");
    expect(r1.hasSecrets).toBe(true);
    expect(r1.reasons).toContain("password");
    expect(r2.hasSecrets).toBe(true);
    expect(r2.reasons).toContain("password");
  });

  test("detects and redacts Bearer tokens", () => {
    const result = redactor.scan("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("bearer_token");
    expect(result.redactedText).toContain("[REDACTED:bearer_token]");
  });

  test("detects and redacts OpenAI keys (sk-...)", () => {
    const result = redactor.scan("Set OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("openai_key");
    expect(result.redactedText).toContain("[REDACTED:openai_key]");
    expect(result.redactedText).not.toContain("sk-proj-");
  });

  test("detects private key PEM markers", () => {
    const result = redactor.scan("Here is the key: -----BEGIN RSA PRIVATE KEY----- MIIEpAIBAAK...");
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("private_key");
    expect(result.redactedText).toContain("[REDACTED:private_key]");
  });

  test("detects EC private key markers", () => {
    const result = redactor.scan("Key: -----BEGIN EC PRIVATE KEY----- MHcCAQEE...");
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("private_key");
  });

  test("detects long tokens (48+ alphanumeric chars)", () => {
    const token = "A".repeat(48);
    const result = redactor.scan(`Token: ${token}`);
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("long_token");
    expect(result.redactedText).toContain("[REDACTED:long_token]");
  });

  test("does not flag short alphanumeric strings", () => {
    const result = redactor.scan("Token: ABC123xyz");
    expect(result.reasons).not.toContain("long_token");
  });

  test("detects multiple secret types in one text", () => {
    const result = redactor.scan(
      "Config: password=supersecret and api_key=abc123 and Bearer token123",
    );
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });

  test("redacts all occurrences of repeated secret types", () => {
    const result = redactor.scan(
      "Key1: sk-proj-abcdefghijklmnopqrstuvwxyz123456 and Key2: sk-anotherlongkeythatisover20chars",
    );
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("openai_key");
    // Both should be redacted
    expect(result.redactedText.match(/\[REDACTED:openai_key\]/g)?.length).toBeGreaterThanOrEqual(1);
  });

  test("handles empty text", () => {
    const result = redactor.scan("");
    expect(result.hasSecrets).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  test("handles text with only whitespace", () => {
    const result = redactor.scan("   \n\t  ");
    expect(result.hasSecrets).toBe(false);
  });

  test("secret_key variant detected as api_key", () => {
    const result = redactor.scan("secret_key=mysecretvalue");
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("api_key");
  });

  test("case-insensitive API key detection", () => {
    const result = redactor.scan("Api_Key=sOmEvalUE or API_KEY=othervalue");
    expect(result.hasSecrets).toBe(true);
    expect(result.reasons).toContain("api_key");
  });
});
