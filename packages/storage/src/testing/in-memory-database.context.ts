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
import type { DatabaseContext } from "../database/database.types.js";
import type {
  AuditRecord,
  CreateAuditInput,
} from "../repositories/audit.repository.js";
import type {
  ConversationRecord,
  CreateConversationInput,
  ListConversationsInput,
} from "../repositories/conversation.repository.js";
import type {
  CreateMessageInput,
  MessageRecord,
} from "../repositories/message.repository.js";
import type {
  CreateModelCallInput,
  ModelCallRecord,
  ModelCallStatus,
} from "../repositories/model-call.repository.js";
import type {
  CreateRunStatusHistoryInput,
  RunStatusHistoryRecord,
} from "../repositories/run-status-history.repository.js";
import type { SettingRecord } from "../repositories/setting.repository.js";
import type {
  CompleteToolCallInput,
  CreateToolCallInput,
  ToolCallRecord,
  ToolCallStatus,
} from "../repositories/tool-call.repository.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  ReserveIdempotencyInput,
} from "../repositories/idempotency.repository.js";

function byCreatedAt<T extends { createdAt: string }>(
  left: T,
  right: T,
): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function byUpdatedAtDesc<T extends { updatedAt: string }>(
  left: T,
  right: T,
): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

export class InMemoryDatabaseContext implements DatabaseContext {
  private readonly conversationRecords = new Map<string, ConversationRecord>();
  private readonly messageRecords = new Map<string, MessageRecord[]>();
  private readonly modelCallRecords = new Map<string, ModelCallRecord>();
  private readonly runRecords = new Map<string, RunRecord>();
  private readonly runStatusHistoryRecords: RunStatusHistoryRecord[] = [];
  private readonly eventRecords: SunPilotEvent[] = [];
  private readonly stepRecords = new Map<string, StepRecord>();
  private readonly toolCallRecords = new Map<string, ToolCallRecord>();
  private readonly approvalRecords = new Map<string, ApprovalRecord>();
  private readonly artifactRecords = new Map<string, ArtifactRecord>();
  private readonly memoryRecords: MemoryRecord[] = [];
  private readonly settingRecords = new Map<string, SettingRecord>();
  private readonly auditRecords: AuditRecord[] = [];
  private readonly idempotencyRecords = new Map<string, IdempotencyRecord>();
  private readonly skillRecords = new Map<string, InstalledSkillRecord>();

  readonly conversations = {
    create: async (
      input: CreateConversationInput = {},
    ): Promise<ConversationRecord> => {
      const now = new Date().toISOString();
      const conversation: ConversationRecord = {
        id: input.id ?? `conv_${crypto.randomUUID()}`,
        title: input.title,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      this.conversationRecords.set(conversation.id, conversation);
      this.messageRecords.set(conversation.id, []);
      return conversation;
    },
    findById: async (id: string): Promise<ConversationRecord | null> =>
      this.conversationRecords.get(id) ?? null,
    list: async (
      input: ListConversationsInput = {},
    ): Promise<ConversationRecord[]> =>
      [...this.conversationRecords.values()]
        .sort(byUpdatedAtDesc)
        .filter((conversation) =>
          isAfterDescendingCursor(
            { updatedAt: conversation.updatedAt, id: conversation.id },
            input.cursor,
          ),
        )
        .slice(0, input.limit ?? 50),
    touch: async (id: string): Promise<void> => {
      const conversation = this.conversationRecords.get(id);
      if (conversation)
        this.conversationRecords.set(id, {
          ...conversation,
          updatedAt: new Date().toISOString(),
        });
    },
    delete: async (id: string): Promise<boolean> => {
      const deleted = this.conversationRecords.delete(id);
      this.messageRecords.delete(id);
      return deleted;
    },
  };

  readonly messages = {
    create: async (input: CreateMessageInput): Promise<MessageRecord> => {
      const now = new Date().toISOString();
      const message: MessageRecord = {
        id: input.id ?? `msg_${crypto.randomUUID()}`,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        metadata: input.metadata ?? {},
        createdAt: now,
      };
      this.messageRecords.set(input.conversationId, [
        ...(this.messageRecords.get(input.conversationId) ?? []),
        message,
      ]);
      const conversation = this.conversationRecords.get(input.conversationId);
      if (conversation)
        this.conversationRecords.set(conversation.id, {
          ...conversation,
          updatedAt: now,
        });
      return message;
    },
    listByConversationId: async (
      conversationId: string,
    ): Promise<MessageRecord[]> => [
      ...(this.messageRecords.get(conversationId) ?? []),
    ],
  };

  readonly modelCalls = {
    create: async (input: CreateModelCallInput): Promise<ModelCallRecord> => {
      const record: ModelCallRecord = {
        id: input.id ?? `model_${crypto.randomUUID()}`,
        runId: input.runId,
        provider: input.provider,
        model: input.model,
        purpose: input.purpose,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        latencyMs: input.latencyMs,
        costEstimate: input.costEstimate,
        status: input.status ?? "pending",
        error: input.error,
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      this.modelCallRecords.set(record.id, record);
      return record;
    },
    updateStatus: async (
      id: string,
      status: ModelCallStatus,
      input: {
        inputTokens?: number;
        outputTokens?: number;
        latencyMs?: number;
        costEstimate?: number;
        error?: unknown;
      } = {},
    ): Promise<ModelCallRecord | null> => {
      const record = this.modelCallRecords.get(id);
      if (!record) return null;
      const updated: ModelCallRecord = {
        ...record,
        status,
        inputTokens: input.inputTokens ?? record.inputTokens,
        outputTokens: input.outputTokens ?? record.outputTokens,
        latencyMs: input.latencyMs ?? record.latencyMs,
        costEstimate: input.costEstimate ?? record.costEstimate,
        error: input.error === undefined ? record.error : input.error,
      };
      this.modelCallRecords.set(id, updated);
      return updated;
    },
    findById: async (id: string): Promise<ModelCallRecord | null> =>
      this.modelCallRecords.get(id) ?? null,
    listByRunId: async (runId: string): Promise<ModelCallRecord[]> =>
      [...this.modelCallRecords.values()]
        .filter((record) => record.runId === runId)
        .sort(byCreatedAt),
  };

  readonly runs = {
    create: async (input: RunRecord): Promise<RunRecord> => {
      this.runRecords.set(input.id, input);
      return input;
    },
    findById: async (id: string): Promise<RunRecord | null> =>
      this.runRecords.get(id) ?? null,
    list: async (
      input: {
        limit?: number;
        status?: RunStatus;
        mode?: string;
        conversationId?: string;
        cursor?: string;
      } = {},
    ): Promise<RunRecord[]> =>
      [...this.runRecords.values()]
        .filter((run) => !input.status || run.status === input.status)
        .filter((run) => !input.mode || run.mode === input.mode)
        .filter(
          (run) =>
            !input.conversationId ||
            run.conversationId === input.conversationId,
        )
        .sort(byUpdatedAtDesc)
        .filter((run) =>
          isAfterDescendingCursor(
            { updatedAt: run.updatedAt, id: run.id },
            input.cursor,
          ),
        )
        .slice(0, input.limit ?? 100),
    updateStatus: async (
      id: string,
      input: {
        status: RunStatus;
        updatedAt?: string;
        completedAt?: string;
        cancelledAt?: string;
        error?: unknown;
      },
    ): Promise<void> => {
      const run = this.runRecords.get(id);
      if (!run) return;
      const now = new Date().toISOString();
      this.runRecords.set(id, {
        ...run,
        status: input.status,
        updatedAt: input.updatedAt ?? now,
        completedAt: input.completedAt ?? run.completedAt,
        cancelledAt:
          input.cancelledAt ??
          (input.status === "cancelled" ? now : run.cancelledAt),
        error: input.error === undefined ? run.error : input.error,
      });
    },
    updateContext: async (
      id: string,
      context: Record<string, unknown>,
    ): Promise<void> => {
      const run = this.runRecords.get(id);
      if (!run) return;
      this.runRecords.set(id, {
        ...run,
        context,
        updatedAt: new Date().toISOString(),
      });
    },
  };

  readonly runStatusHistory = {
    append: async (
      input: CreateRunStatusHistoryInput,
    ): Promise<RunStatusHistoryRecord> => {
      const record: RunStatusHistoryRecord = {
        id: input.id ?? `rsh_${crypto.randomUUID()}`,
        runId: input.runId,
        previousStatus: input.previousStatus,
        nextStatus: input.nextStatus,
        reason: input.reason,
        actor: input.actor ?? AuditActor.System,
        metadata: input.metadata ?? {},
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      this.runStatusHistoryRecords.push(record);
      return record;
    },
    listByRunId: async (runId: string): Promise<RunStatusHistoryRecord[]> =>
      this.runStatusHistoryRecords
        .filter((record) => record.runId === runId)
        .sort(byCreatedAt),
  };

  readonly events = {
    append: async (event: SunPilotEvent): Promise<SunPilotEvent> => {
      const existing = this.eventRecords.find((item) => item.id === event.id);
      if (existing) return existing;
      const sequenced = {
        ...event,
        sequence: event.sequence ?? this.eventRecords.length + 1,
      };
      this.eventRecords.push(sequenced);
      return sequenced;
    },
    listByRunId: async (runId: string): Promise<SunPilotEvent[]> =>
      this.eventRecords
        .filter((event) => event.runId === runId)
        .sort(byCreatedAt),
    listByConversationId: async (
      conversationId: string,
      afterSequence = 0,
    ): Promise<SunPilotEvent[]> =>
      this.eventRecords
        .filter((event) => event.conversationId === conversationId)
        .filter((event) => (event.sequence ?? 0) > afterSequence)
        .sort(
          (left, right) =>
            (left.sequence ?? 0) - (right.sequence ?? 0) ||
            byCreatedAt(left, right),
        ),
  };

  readonly steps = {
    create: async (input: StepRecord): Promise<StepRecord> => {
      this.stepRecords.set(input.id, input);
      return input;
    },
    listByRunId: async (runId: string): Promise<StepRecord[]> =>
      [...this.stepRecords.values()].filter((step) => step.runId === runId),
    updateStatus: async (
      stepId: string,
      status: StepStatus,
      output?: unknown,
      error?: unknown,
    ): Promise<void> => {
      const step = this.stepRecords.get(stepId);
      if (!step) return;
      this.stepRecords.set(stepId, {
        ...step,
        status,
        output: output === undefined ? step.output : output,
        error: error === undefined ? step.error : error,
        completedAt: [
          "completed",
          "failed",
          "skipped",
          "cancelled",
          "interrupted",
        ].includes(status)
          ? new Date().toISOString()
          : step.completedAt,
      });
    },
  };

  readonly toolCalls = {
    create: async (input: CreateToolCallInput): Promise<ToolCallRecord> => {
      const existing = this.toolCallRecords.get(input.id);
      if (existing) {
        const updated = {
          ...existing,
          status: input.status ?? existing.status,
          startedAt: existing.startedAt ?? input.startedAt,
        };
        this.toolCallRecords.set(input.id, updated);
        return updated;
      }
      const record: ToolCallRecord = {
        id: input.id,
        runId: input.runId,
        stepId: input.stepId,
        skillId: input.skillId,
        name: input.name,
        arguments: input.arguments ?? {},
        status: input.status ?? "pending",
        riskLevel: input.riskLevel ?? "low",
        approvalId: input.approvalId,
        startedAt: input.startedAt,
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      this.toolCallRecords.set(record.id, record);
      return record;
    },
    updateStatus: async (
      id: string,
      status: ToolCallStatus,
      input: CompleteToolCallInput = {},
    ): Promise<ToolCallRecord | null> => {
      const record = this.toolCallRecords.get(id);
      if (!record) return null;
      const terminal = ["completed", "failed", "cancelled", "timeout"].includes(
        status,
      );
      const updated: ToolCallRecord = {
        ...record,
        status,
        result: input.result === undefined ? record.result : input.result,
        error: input.error === undefined ? record.error : input.error,
        startedAt:
          status === "running"
            ? (record.startedAt ?? new Date().toISOString())
            : record.startedAt,
        completedAt: terminal
          ? (input.completedAt ?? new Date().toISOString())
          : record.completedAt,
      };
      this.toolCallRecords.set(id, updated);
      return updated;
    },
    findById: async (id: string): Promise<ToolCallRecord | null> =>
      this.toolCallRecords.get(id) ?? null,
    listByRunId: async (runId: string): Promise<ToolCallRecord[]> =>
      [...this.toolCallRecords.values()]
        .filter((record) => record.runId === runId)
        .sort(byCreatedAt),
  };

  readonly approvals = {
    create: async (input: ApprovalRecord): Promise<ApprovalRecord> => {
      this.approvalRecords.set(input.id, input);
      return input;
    },
    decide: async (
      id: string,
      status: "approved" | "rejected",
      decision: unknown,
    ): Promise<ApprovalRecord | null> => {
      const approval = this.approvalRecords.get(id);
      if (!approval) return null;
      if (approval.status !== "pending") return approval;
      const decidedBy =
        decision &&
        typeof decision === "object" &&
        typeof (decision as { decidedBy?: unknown }).decidedBy === "string"
          ? (decision as { decidedBy: string }).decidedBy
          : approval.decidedBy;
      const updated = {
        ...approval,
        status,
        decision,
        decidedBy,
        decidedAt: new Date().toISOString(),
      };
      this.approvalRecords.set(id, updated);
      return updated;
    },
    expire: async (id: string): Promise<ApprovalRecord | null> => {
      const approval = this.approvalRecords.get(id);
      if (!approval) return null;
      if (approval.status !== "pending") return approval;
      const updated = { ...approval, status: "expired" as const };
      this.approvalRecords.set(id, updated);
      return updated;
    },
    findById: async (id: string): Promise<ApprovalRecord | null> =>
      this.approvalRecords.get(id) ?? null,
    list: async (
      input: {
        status?: ApprovalRecord["status"];
        runId?: string;
        limit?: number;
      } = {},
    ): Promise<ApprovalRecord[]> =>
      [...this.approvalRecords.values()]
        .filter((approval) => !input.status || approval.status === input.status)
        .filter((approval) => !input.runId || approval.runId === input.runId)
        .sort(byCreatedAt)
        .slice(0, input.limit ?? 100),
  };

  readonly artifacts = {
    create: async (input: ArtifactRecord): Promise<ArtifactRecord> => {
      this.artifactRecords.set(input.id, input);
      return input;
    },
    findById: async (id: string): Promise<ArtifactRecord | null> =>
      this.artifactRecords.get(id) ?? null,
    list: async (runId?: string): Promise<ArtifactRecord[]> =>
      [...this.artifactRecords.values()]
        .filter((artifact) => !runId || artifact.runId === runId)
        .sort(byCreatedAt),
  };

  readonly memory = {
    create: async (input: MemoryRecord): Promise<MemoryRecord> => {
      const normalized = normalizeMemoryRecord(input);
      this.memoryRecords.push(normalized);
      return normalized;
    },
    update: async (
      id: string,
      input: Partial<MemoryRecord>,
    ): Promise<MemoryRecord | null> => {
      const index = this.memoryRecords.findIndex((memory) => memory.id === id);
      if (index < 0) return null;
      const existing = this.memoryRecords[index]!;
      const updated = normalizeMemoryRecord({
        ...existing,
        ...definedPatch(input),
        id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
        metadata:
          input.metadata === undefined ? existing.metadata : input.metadata,
      });
      this.memoryRecords[index] = updated;
      return updated;
    },
    list: async (
      input: {
        query?: string;
        runId?: string;
        key?: string;
        userId?: string;
        projectId?: string;
        conversationId?: string;
        scopes?: MemoryRecord["scope"][];
        types?: MemoryRecord["type"][];
        includeDeleted?: boolean;
        limit?: number;
      } = {},
    ): Promise<MemoryRecord[]> =>
      filterMemories(this.memoryRecords, input)
        .sort(byCreatedAt)
        .slice(0, input.limit ?? 100),
    search: async (
      input: {
        query?: string;
        runId?: string;
        key?: string;
        userId?: string;
        projectId?: string;
        conversationId?: string;
        scopes?: MemoryRecord["scope"][];
        types?: MemoryRecord["type"][];
        includeDeleted?: boolean;
        limit?: number;
      } = {},
    ) =>
      filterMemories(this.memoryRecords, input)
        .map((memory) => scoreMemory(memory, input.query))
        .sort(
          (a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt),
        )
        .slice(0, input.limit ?? 10),
    markAccessed: async (
      id: string,
      accessedAt = new Date().toISOString(),
    ): Promise<void> => {
      const index = this.memoryRecords.findIndex((memory) => memory.id === id);
      if (index >= 0) {
        const existing = this.memoryRecords[index]!;
        this.memoryRecords[index] = {
          ...existing,
          lastAccessedAt: accessedAt,
          updatedAt: accessedAt,
        };
      }
    },
    supersede: async (id: string, supersededBy: string): Promise<void> => {
      const index = this.memoryRecords.findIndex((memory) => memory.id === id);
      if (index >= 0) {
        const existing = this.memoryRecords[index]!;
        this.memoryRecords[index] = {
          ...existing,
          supersededBy,
          updatedAt: new Date().toISOString(),
        };
      }
    },
    softDelete: async (
      id: string,
      reason: string,
      deletedAt = new Date().toISOString(),
    ): Promise<void> => {
      const index = this.memoryRecords.findIndex((memory) => memory.id === id);
      if (index >= 0) {
        const existing = this.memoryRecords[index]!;
        this.memoryRecords[index] = {
          ...existing,
          deletedAt,
          updatedAt: deletedAt,
          metadata: { ...existing.metadata, deleteReason: reason },
        };
      }
    },
  };

  readonly settings = {
    set: async (key: string, value: unknown): Promise<SettingRecord> => {
      const setting = { key, value, updatedAt: new Date().toISOString() };
      this.settingRecords.set(key, setting);
      return setting;
    },
    get: async (key: string): Promise<SettingRecord | null> =>
      this.settingRecords.get(key) ?? null,
  };

  readonly audit = {
    create: async (input: CreateAuditInput): Promise<AuditRecord> => {
      const record: AuditRecord = {
        id: input.id ?? `audit_${crypto.randomUUID()}`,
        runId: input.runId,
        stepId: input.stepId,
        actor: input.actor,
        action: input.action,
        target: input.target,
        risk: input.risk,
        payload: input.payload,
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      this.auditRecords.push(record);
      return record;
    },
    list: async (runId?: string): Promise<AuditRecord[]> =>
      this.auditRecords
        .filter((record) => !runId || record.runId === runId)
        .sort(byCreatedAt),
  };

  readonly idempotency = {
    reserve: async (
      input: ReserveIdempotencyInput,
    ): Promise<{
      inserted: boolean;
      record: IdempotencyRecord;
    }> => {
      const existing = [...this.idempotencyRecords.values()].find(
        (record) =>
          (record.userId ?? "") === (input.userId ?? "") &&
          record.method === input.method &&
          record.clientRequestId === input.clientRequestId,
      );
      if (existing) return { inserted: false, record: existing };

      const record: IdempotencyRecord = {
        id: input.id ?? `idem_${crypto.randomUUID()}`,
        userId: input.userId,
        method: input.method,
        clientRequestId: input.clientRequestId,
        requestHash: input.requestHash,
        response: input.initialResponse,
        status: "processing",
        createdAt: new Date().toISOString(),
        expiresAt: input.expiresAt,
      };
      this.idempotencyRecords.set(record.id, record);
      return { inserted: true, record };
    },
    complete: async (
      id: string,
      response: unknown,
    ): Promise<IdempotencyRecord | null> => {
      return this.updateIdempotency(id, "completed", {
        response,
        error: undefined,
      });
    },
    fail: async (
      id: string,
      error: unknown,
    ): Promise<IdempotencyRecord | null> => {
      return this.updateIdempotency(id, "failed", { error });
    },
    findByKey: async (input: {
      userId?: string;
      method: string;
      clientRequestId: string;
    }): Promise<IdempotencyRecord | null> =>
      [...this.idempotencyRecords.values()].find(
        (record) =>
          (record.userId ?? "") === (input.userId ?? "") &&
          record.method === input.method &&
          record.clientRequestId === input.clientRequestId,
      ) ?? null,
  };

  readonly skills = {
    upsert: async (
      input: InstalledSkillRecord,
    ): Promise<InstalledSkillRecord> => {
      this.skillRecords.set(input.id, input);
      return input;
    },
    list: async (): Promise<InstalledSkillRecord[]> =>
      [...this.skillRecords.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    findById: async (id: string): Promise<InstalledSkillRecord | null> =>
      this.skillRecords.get(id) ?? null,
    setEnabled: async (
      id: string,
      enabled: boolean,
    ): Promise<InstalledSkillRecord | null> => {
      const skill = this.skillRecords.get(id);
      if (!skill) return null;
      const updated = {
        ...skill,
        enabled,
        updatedAt: new Date().toISOString(),
      };
      this.skillRecords.set(id, updated);
      return updated;
    },
  };

  reset(): void {
    this.conversationRecords.clear();
    this.messageRecords.clear();
    this.modelCallRecords.clear();
    this.runRecords.clear();
    this.runStatusHistoryRecords.length = 0;
    this.eventRecords.length = 0;
    this.stepRecords.clear();
    this.toolCallRecords.clear();
    this.approvalRecords.clear();
    this.artifactRecords.clear();
    this.memoryRecords.length = 0;
    this.settingRecords.clear();
    this.auditRecords.length = 0;
    this.idempotencyRecords.clear();
    this.skillRecords.clear();
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  async transaction<T>(
    work: (database: InMemoryDatabaseContext) => Promise<T>,
  ): Promise<T> {
    return work(this);
  }

  private updateIdempotency(
    id: string,
    status: IdempotencyStatus,
    patch: { response?: unknown; error?: unknown },
  ): IdempotencyRecord | null {
    const record = this.idempotencyRecords.get(id);
    if (!record) return null;
    const updated: IdempotencyRecord = {
      ...record,
      status,
      response: patch.response === undefined ? record.response : patch.response,
      error: patch.error === undefined ? record.error : patch.error,
    };
    this.idempotencyRecords.set(id, updated);
    return updated;
  }
}

type MemoryFilter = {
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

function definedPatch<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function normalizeMemoryRecord(input: MemoryRecord): MemoryRecord {
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

function filterMemories(
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

function isMemoryVisible(memory: MemoryRecord, input: MemoryFilter): boolean {
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

function matchesMemoryQuery(memory: MemoryRecord, query?: string): boolean {
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

function scoreMemory(memory: MemoryRecord, query?: string) {
  const relevance = memoryRelevance(memory, query);
  const confidence = memory.confidence ?? 0.8;
  const importance = memory.importance ?? 0.5;
  const recency = memoryRecency(memory.updatedAt ?? memory.createdAt);
  const score =
    relevance * 0.45 + importance * 0.2 + recency * 0.15 + confidence * 0.15;
  return { ...memory, score, relevance };
}

function memoryRelevance(memory: MemoryRecord, query?: string): number {
  if (!query?.trim()) return 0;
  const needle = query.toLowerCase();
  let score = 0;
  if (memory.title?.toLowerCase().includes(needle)) score += 1;
  if (memory.summary?.toLowerCase().includes(needle)) score += 0.7;
  if (memory.content?.toLowerCase().includes(needle)) score += 0.5;
  if (memory.key.toLowerCase().includes(needle)) score += 0.4;
  return score;
}

function memoryRecency(updatedAt: string): number {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, 1 - ageMs / monthMs);
}

function stringifyMemoryValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function isAfterDescendingCursor(
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
