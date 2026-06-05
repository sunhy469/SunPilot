export const TOKEN_STORAGE_KEY = "sunpilot.token";

export function getInitialToken(): string {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") ?? localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    if (params.has("token")) history.replaceState(null, "", location.pathname + location.hash);
  }
  return token;
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function createRequest(token: string) {
  return async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers
      }
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<T>;
  };
}
