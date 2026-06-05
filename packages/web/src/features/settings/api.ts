import type { createRequest } from "../../shared/api/client";

type Request = ReturnType<typeof createRequest>;

export function getReady(request: Request) {
  return request<Record<string, unknown>>("/readyz");
}
