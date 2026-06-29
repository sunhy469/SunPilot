import { getLocalToken } from "../auth/local-token";

export function createRequest() {
  return async function request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const localToken = getLocalToken();
    if (localToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${localToken}`);
    }
    const response = await fetch(path, {
      ...options,
      headers,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<T>;
  };
}
