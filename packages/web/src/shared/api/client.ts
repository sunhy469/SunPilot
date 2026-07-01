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
    if (!response.ok) {
      const body = await response.text();
      throw Object.assign(new Error(body), { status: response.status });
    }
    return response.json() as Promise<T>;
  };
}

/** Authenticated request that returns raw text (for non-JSON responses like
 *  artifact content). Shares the same token injection as createRequest. */
export function createRawRequest() {
  return async function requestText(
    path: string,
    options: RequestInit = {},
  ): Promise<string> {
    const headers = new Headers(options.headers);
    const localToken = getLocalToken();
    if (localToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${localToken}`);
    }
    const response = await fetch(path, { ...options, headers });
    if (!response.ok) {
      const body = await response.text();
      throw Object.assign(new Error(body), { status: response.status });
    }
    return response.text();
  };
}
