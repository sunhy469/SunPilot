import {
  AuditActor,
  type ApprovalRecord,
  type ArtifactRecord,
  type InstalledSkillRecord,
  type MemoryRecord,
  type RunRecord,
  type RunStatus,
  type StepRecord,
  type StepStatus,
  type SunPilotEvent,
} from "@sunpilot/protocol";
import type { DatabaseContext } from "../../database/database.types.js";
import type {
  AuditRecord,
  CreateAuditInput,
} from "../../repositories/audit.repository.js";
import type {
  ConversationRecord,
  CreateConversationInput,
  ListConversationsInput,
  UpdateConversationPatch,
} from "../../repositories/conversation.repository.js";
import type {
  CreateMessageInput,
  MessageRecord,
} from "../../repositories/message.repository.js";
import type {
  CreateModelCallInput,
  ModelCallRecord,
  ModelCallStatus,
} from "../../repositories/model-call.repository.js";
import type {
  CreateRunStatusHistoryInput,
  RunStatusHistoryRecord,
} from "../../repositories/run-status-history.repository.js";
import type { SettingRecord } from "../../repositories/setting.repository.js";
import type {
  CompleteToolCallInput,
  CreateToolCallInput,
  ToolCallRecord,
  ToolCallStatus,
} from "../../repositories/tool-call.repository.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  ReserveIdempotencyInput,
} from "../../repositories/idempotency.repository.js";
import type {
  DigitalBeingRecord,
  CreateDigitalBeingInput,
  UpdateDigitalBeingPatch,
} from "../../repositories/digital-being.repository.js";
import type {
  WorldNodeRecord,
  CreateWorldNodeInput,
} from "../../repositories/world-node.repository.js";
import type {
  WorldEdgeRecord,
  CreateWorldEdgeInput,
} from "../../repositories/world-edge.repository.js";
import type {
  WorldTaskRecord,
  CreateWorldTaskInput,
  UpdateWorldTaskPatch,
} from "../../repositories/world-task.repository.js";
import type {
  WorldActionRecord,
  CreateWorldActionInput,
  UpdateWorldActionPatch,
} from "../../repositories/world-action.repository.js";
import type {
  WorldArtifactRecord,
  CreateWorldArtifactInput,
  UpdateWorldArtifactPatch,
} from "../../repositories/world-artifact.repository.js";
import type {
  WorldActionLogRecord,
  CreateWorldActionLogInput,
} from "../../repositories/world-action-log.repository.js";

export function byCreatedAt<T extends { createdAt: string }>(
  left: T,
  right: T,
): number {
  return left.createdAt.localeCompare(right.createdAt);
}

export function byCreatedAtDesc<T extends { createdAt: string }>(
  left: T,
  right: T,
): number {
  return right.createdAt.localeCompare(left.createdAt);
}

export function byUpdatedAtDesc<T extends { updatedAt: string }>(
  left: T,
  right: T,
): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

export function byPinnedAndUpdatedAtDesc<T extends { pinned?: boolean; updatedAt: string }>(
  left: T,
  right: T,
): number {
  const lp = left.pinned ? 1 : 0;
  const rp = right.pinned ? 1 : 0;
  if (rp !== lp) return rp - lp;
  return right.updatedAt.localeCompare(left.updatedAt);
}

export type MemoryFilter = {
  query?: string;
  runId?: string;
  key?: string;
  userId?: string;
  projectId?: string;
  conversationId?: string;
  scopes?: MemoryRecord["scope"][];
  types?: MemoryRecord["type"][];
  includeDeleted?: boolean;
};

export type MemoryRelationEntry = {
  sourceMemoryId?: string;
  targetMemoryId: string;
  relation: string;
  reason?: string;
  confidence?: number;
  establishedAt: string;
  createdAt: string;
};

export type InMemorySnapshot = {
  conversationRecords: Map<string, ConversationRecord>;
  messageRecords: Map<string, MessageRecord[]>;
  modelCallRecords: Map<string, ModelCallRecord>;
  runRecords: Map<string, RunRecord>;
  runStatusHistoryRecords: RunStatusHistoryRecord[];
  eventRecords: SunPilotEvent[];
  stepRecords: Map<string, StepRecord>;
  toolCallRecords: Map<string, ToolCallRecord>;
  approvalRecords: Map<string, ApprovalRecord>;
  artifactRecords: Map<string, ArtifactRecord>;
  memoryRecords: MemoryRecord[];
  memoryRelationsMap: Map<string, MemoryRelationEntry[]>;
  settingRecords: Map<string, SettingRecord>;
  auditRecords: AuditRecord[];
  idempotencyRecords: Map<string, IdempotencyRecord>;
  skillRecords: Map<string, InstalledSkillRecord>;
  digitalBeingRecords: Map<string, DigitalBeingRecord>;
  worldNodeRecords: Map<string, WorldNodeRecord>;
  worldEdgeRecords: Map<string, WorldEdgeRecord>;
  worldTaskRecords: Map<string, WorldTaskRecord>;
  worldActionRecords: Map<string, WorldActionRecord>;
  worldActionLogRecords: WorldActionLogRecord[];
  worldArtifactRecords: Map<string, WorldArtifactRecord>;
};

export function definedPatch<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export function normalizeMemoryRecord(input: MemoryRecord): MemoryRecord {
  const content = input.content ?? stringifyMemoryValue(input.value);
  const scope = input.scope ?? (input.runId ? "run" : "global");
  return {
    ...input,
    scope,
    scopeId: input.scopeId ?? (scope === "run" ? input.runId : undefined),
    type: input.type ?? "manual_note",
    title: input.title ?? input.key,
    content,
    summary: input.summary ?? content,
    source: input.source ?? "runtime",
    confidence: input.confidence ?? 0.8,
    importance: input.importance ?? 0.5,
    updatedAt: input.updatedAt ?? input.createdAt,
    metadata: input.metadata ?? {},
  };
}

export function filterMemories(
  memories: MemoryRecord[],
  input: MemoryFilter,
): MemoryRecord[] {
  return memories
    .filter((memory) => input.includeDeleted || !memory.deletedAt)
    .filter(
      (memory) =>
        !memory.expiresAt || memory.expiresAt > new Date().toISOString(),
    )
    .filter((memory) => !memory.supersededBy)
    .filter(
      (memory) =>
        !input.runId ||
        memory.runId === input.runId ||
        (memory.scope === "run" && memory.scopeId === input.runId),
    )
    .filter((memory) => !input.key || memory.key === input.key)
    .filter(
      (memory) => !input.types?.length || input.types.includes(memory.type),
    )
    .filter((memory) => isMemoryVisible(memory, input))
    .filter((memory) => matchesMemoryQuery(memory, input.query));
}

export function isMemoryVisible(memory: MemoryRecord, input: MemoryFilter): boolean {
  const scopes = input.scopes ?? [
    "global",
    "user",
    "project",
    "conversation",
    "run",
  ];
  if (!scopes.includes(memory.scope)) return false;
  switch (memory.scope) {
    case "global":
      return true;
    case "user":
      return Boolean(input.userId && memory.scopeId === input.userId);
    case "project":
      return Boolean(input.projectId && memory.scopeId === input.projectId);
    case "conversation":
      return Boolean(
        input.conversationId && memory.scopeId === input.conversationId,
      );
    case "run":
      return Boolean(input.runId && memory.scopeId === input.runId);
    default:
      return false;
  }
}

export function matchesMemoryQuery(memory: MemoryRecord, query?: string): boolean {
  if (!query?.trim()) return true;
  const needle = query.toLowerCase();
  return [
    memory.key,
    memory.title,
    memory.summary,
    memory.content,
    stringifyMemoryValue(memory.value),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

export function scoreMemory(memory: MemoryRecord, query?: string) {
  const relevance = memoryRelevance(memory, query);
  const confidence = memory.confidence ?? 0.8;
  const importance = memory.importance ?? 0.5;
  const recency = memoryRecency(memory.updatedAt ?? memory.createdAt);
  const score =
    relevance * 0.45 + importance * 0.2 + recency * 0.15 + confidence * 0.15;
  return { ...memory, score, relevance };
}

export function memoryRelevance(memory: MemoryRecord, query?: string): number {
  if (!query?.trim()) return 0;
  const needle = query.toLowerCase();
  let score = 0;
  if (memory.title?.toLowerCase().includes(needle)) score += 1;
  if (memory.summary?.toLowerCase().includes(needle)) score += 0.7;
  if (memory.content?.toLowerCase().includes(needle)) score += 0.5;
  if (memory.key.toLowerCase().includes(needle)) score += 0.4;
  return score;
}

export function memoryRecency(updatedAt: string): number {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, 1 - ageMs / monthMs);
}

export function stringifyMemoryValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

export function isAfterDescendingCursor(
  record: { updatedAt: string; id: string },
  cursor?: string,
): boolean {
  if (!cursor) return true;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      updatedAt?: string;
      id?: string;
    };
    if (!decoded.updatedAt || !decoded.id) return true;
    if (record.updatedAt < decoded.updatedAt) return true;
    return record.updatedAt === decoded.updatedAt && record.id < decoded.id;
  } catch {
    return true;
  }
}
