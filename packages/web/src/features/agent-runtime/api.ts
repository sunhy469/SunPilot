import type { createRequest } from "../../shared/api/client";

type Request = ReturnType<typeof createRequest>;

export interface AgentApproval {
  id: string;
  runId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  risk: "low" | "medium" | "high" | "critical";
  title: string;
  reason?: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface AgentEventRecord {
  id: string;
  runId?: string;
  conversationId?: string;
  sequence?: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface AgentArtifact {
  id: string;
  runId: string;
  stepId?: string;
  conversationId?: string;
  type: string;
  name: string;
  path?: string;
  storageKey?: string;
  checksum?: string;
  version?: number;
  mimeType?: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export function listPendingApprovals(request: Request) {
  return request<{ items: AgentApproval[] }>("/v1/approvals?status=pending");
}

export function approveAgentApproval(request: Request, approvalId: string) {
  return request<{ approved: boolean }>(`/v1/approvals/${approvalId}/approve`, {
    method: "POST",
    body: JSON.stringify({ actor: "web" }),
  });
}

export function rejectAgentApproval(request: Request, approvalId: string) {
  return request<{ rejected: boolean }>(`/v1/approvals/${approvalId}/reject`, {
    method: "POST",
    body: JSON.stringify({ actor: "web" }),
  });
}

export function replayConversationEvents(
  request: Request,
  conversationId: string,
  afterSequence = 0,
) {
  return request<{ conversationId: string; items: AgentEventRecord[] }>(
    `/v1/conversations/${conversationId}/events?afterSequence=${afterSequence}`,
  );
}

export function getAgentArtifact(request: Request, artifactId: string) {
  return request<AgentArtifact>(`/v1/artifacts/${artifactId}`);
}

export async function getAgentArtifactContent(artifactId: string) {
  const response = await fetch(`/v1/artifacts/${artifactId}/content`);
  if (!response.ok) throw new Error(await response.text());
  return response.text();
}
