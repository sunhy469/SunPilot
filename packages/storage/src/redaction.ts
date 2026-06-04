const SENSITIVE_KEY = /token|api[-_]?key|authorization|cookie|secret|password/i;
const SENSITIVE_VALUE = /(Bearer\s+)[^\s",]+|(sun_)[a-f0-9]{32,}|(sk-)[A-Za-z0-9_-]{16,}/gi;
const SENSITIVE_NAME = /\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\b/g;

export function redactSensitive(value: unknown, localPaths: string[] = []): unknown {
  if (typeof value === "string") {
    let redacted = value
      .replace(SENSITIVE_VALUE, (_match, bearer, sun, apiKey) => `${bearer ?? sun ?? apiKey ?? ""}[REDACTED]`)
      .replace(SENSITIVE_NAME, "[REDACTED_NAME]");
    for (const path of localPaths.filter(Boolean).sort((a, b) => b.length - a.length)) {
      redacted = redacted.replaceAll(path, "[LOCAL_PATH]");
    }
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, localPaths));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(item, localPaths)
      ])
    );
  }
  return value;
}
