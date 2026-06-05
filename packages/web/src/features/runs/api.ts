import type { createRequest } from "../../shared/api/client";
import type { RunSummary } from "./types";

type Request = ReturnType<typeof createRequest>;

export function listRuns(request: Request) {
  return request<RunSummary[]>("/v1/runs");
}
