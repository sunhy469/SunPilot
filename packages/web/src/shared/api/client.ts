export function createRequest() {
  return async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<T>;
  };
}
