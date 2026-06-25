import type { SecretRedactor, SecretScanResult } from "./memory-types.js";

// §B1: All patterns carry the `g` flag so `String.replace` replaces every
// occurrence. Order matters — more specific / longer-running patterns must run
// before the generic `long_token` fallback so JWT segments, OpenAI keys and
// bearer payloads are not swallowed piecemeal.
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "api_key", pattern: /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi },
  { name: "password", pattern: /\b(?:password|passwd|pwd)\b\s*[:=]\s*[^\s,;]+/gi },
  { name: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { name: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github_pat", pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "long_token", pattern: /\b[A-Za-z0-9_-]{48,}\b/g },
];

export class PatternSecretRedactor implements SecretRedactor {
  scan(text: string): SecretScanResult {
    const reasons: string[] = [];
    let redactedText = text;

    for (const { name, pattern } of SECRET_PATTERNS) {
      // Reset lastIndex defensively (shared `g` regexes can carry state).
      pattern.lastIndex = 0;
      const replaced = redactedText.replace(pattern, `[REDACTED:${name}]`);
      if (replaced !== redactedText) {
        reasons.push(name);
        redactedText = replaced;
      }
    }

    return {
      hasSecrets: reasons.length > 0,
      redactedText,
      reasons,
    };
  }
}
