import type { createRequest } from "../../shared/api/client";
import { endpoints } from "../../shared/api/endpoints";

type Request = ReturnType<typeof createRequest>;

export interface WorldStateResponse {
  nodes: {
    id: string;
    type: string;
    name: string;
    posX: number;
    posY: number;
    sizeWidth: number;
    sizeHeight: number;
    icon?: string;
    logo?: string;
    enabled: boolean;
  }[];
  edges: {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    distance: number;
    bidirectional: boolean;
    locked: boolean;
  }[];
  beings: {
    id: string;
    name: string;
    status: string;
    currentNodeId: string;
    homeNodeId: string;
    statusText?: string;
    sleepReason?: string;
    conversationId?: string;
  }[];
}

export type BeingInfo = WorldStateResponse["beings"][0];

export function getWorldState(request: Request) {
  return request<WorldStateResponse>(endpoints.digitalWorld);
}

export function listDigitalBeings(request: Request) {
  return request<{ items: BeingInfo[] }>(endpoints.digitalBeings).then((res) => res.items);
}

export function createDigitalBeing(
  request: Request,
  input: { name: string; homeNodeId: string; description?: string },
) {
  return request<{ item: BeingInfo }>(endpoints.digitalBeings, {
    method: "POST",
    body: JSON.stringify(input),
  }).then((res) => res.item);
}

export function getDigitalBeing(request: Request, id: string) {
  return request<{ item: BeingInfo }>(endpoints.digitalBeingById(id)).then((res) => res.item);
}

export function updateDigitalBeing(
  request: Request,
  id: string,
  patch: { name?: string; status?: string; statusText?: string },
) {
  return request<{ item: BeingInfo }>(endpoints.digitalBeingById(id), {
    method: "PATCH",
    body: JSON.stringify(patch),
  }).then((res) => res.item);
}

export function createTask(
  request: Request,
  beingId: string,
  input: { type: string; title: string; input?: Record<string, unknown> },
) {
  return request<{ item: unknown }>(endpoints.digitalBeingTasks(beingId), {
    method: "POST",
    body: JSON.stringify(input),
  }).then((res) => res.item);
}

export function listTasks(request: Request, beingId: string) {
  return request<{ items: unknown[] }>(endpoints.digitalBeingTasks(beingId)).then((res) => res.items);
}

export function sleepBeing(request: Request, id: string, reason?: string) {
  return request<{ item: unknown }>(endpoints.digitalBeingSleep(id), {
    method: "POST",
    body: JSON.stringify({ reason }),
  }).then((res) => res.item);
}

export function wakeBeing(request: Request, id: string) {
  return request<{ item: unknown }>(endpoints.digitalBeingWake(id), {
    method: "POST",
  }).then((res) => res.item);
}

export function listActions(request: Request, beingId: string) {
  return request<{ items: unknown[] }>(endpoints.digitalBeingActions(beingId)).then((res) => res.items);
}

export function listActionLogs(request: Request, beingId: string) {
  return request<{ items: unknown[] }>(endpoints.digitalBeingActionLogs(beingId)).then((res) => res.items);
}

export function listArtifacts(request: Request, beingId: string) {
  return request<{ items: unknown[] }>(endpoints.digitalBeingArtifacts(beingId)).then((res) => res.items);
}
