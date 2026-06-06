import type { SecretRedactor, SecretScanResult } from "./memory-types.js";

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "api_key", pattern: /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\b\s*[:=]\s*[^\s,;]+/i },
  { name: "password", pattern: /\b(?:password|passwd|pwd)\b\s*[:=]\s*[^\s,;]+/i },
  { name: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i },
  { name: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "long_token", pattern: /\b[A-Za-z0-9_-]{48,}\b/ },
];

export class PatternSecretRedactor implements SecretRedactor {
  scan(text: string): SecretScanResult {
    const reasons: string[] = [];
    let redactedText = text;

    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(redactedText)) {
        reasons.push(name);
        redactedText = redactedText.replace(pattern, `[REDACTED:${name}]`);
      }
    }

    return {
      hasSecrets: reasons.length > 0,
      redactedText,
      reasons,
    };
  }
}
