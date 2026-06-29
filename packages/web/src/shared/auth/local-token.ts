const STORAGE_KEY = "sunpilot.localToken";
const FRAGMENT_KEY = "sunpilot-token";

function validToken(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

/** Move the launcher-provided URL-fragment token into this tab's storage. */
export function getLocalToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const bootstrapToken = fragment.get(FRAGMENT_KEY);
    if (validToken(bootstrapToken)) {
      window.sessionStorage.setItem(STORAGE_KEY, bootstrapToken);
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      return bootstrapToken;
    }
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    return validToken(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function withLocalTokenQuery(url: string): string {
  const token = getLocalToken();
  if (!token) return url;
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}
