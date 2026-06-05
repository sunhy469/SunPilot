import type {
  ApprovalRecord,
  ArtifactRecord,
  InstalledSkillRecord,
  MemoryRecord,
  RunRecord,
  RunStatus,
  StepRecord,
  StepStatus,
  SunPilotEvent,
  WorkflowRecord
} from "@sunpilot/protocol";
import type { DatabaseContext } from "../database/database.types.js";
import type { AuditRecord, CreateAuditInput } from "../repositories/audit.repository.js";
import type { ConversationRecord, CreateConversationInput, ListConversationsInput } from "../repositories/conversation.repository.js";
import type { CreateJobInput, JobRecord } from "../repositories/job.repository.js";
import type { CreateMessageInput, MessageRecord } from "../repositories/message.repository.js";
import type { SettingRecord } from "../repositories/setting.repository.js";

function byCreatedAt<T extends { createdAt: string }>(left: T, right: T): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function byUpdatedAtDesc<T extends { updatedAt: string }>(left: T, right: T): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

export class InMemoryDatabaseContext implements DatabaseContext {
  private readonly conversationRecords = new Map<string, ConversationRecord>();
  private readonly messageRecords = new Map<string, MessageRecord[]>();
  private readonly runRecords = new Map<string, RunRecord>();
  private readonly eventRecords: SunPilotEvent[] = [];
  private readonly stepRecords = new Map<string, StepRecord>();
  private readonly approvalRecords = new Map<string, ApprovalRecord>();
  private readonly artifactRecords = new Map<string, ArtifactRecord>();
  private readonly memoryRecords: MemoryRecord[] = [];
  private readonly settingRecords = new Map<string, SettingRecord>();
  private readonly auditRecords: AuditRecord[] = [];
  private readonly jobRecords = new Map<string, JobRecord>();
  private readonly workflowRecords = new Map<string, WorkflowRecord>();
  private readonly skillRecords = new Map<string, InstalledSkillRecord>();

  readonly conversations = {
    create: async (input: CreateConversationInput = {}): Promise<ConversationRecord> => {
      const now = new Date().toISOString();
      const conversation: ConversationRecord = {
        id: input.id ?? `conv_${crypto.randomUUID()}`,
        title: input.title,
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      this.conversationRecords.set(conversation.id, conversation);
      this.messageRecords.set(conversation.id, []);
      return conversation;
    },
    findById: async (id: string): Promise<ConversationRecord | null> => this.conversationRecords.get(id) ?? null,
    list: async (input: ListConversationsInput = {}): Promise<ConversationRecord[]> =>
      [...this.conversationRecords.values()].sort(byUpdatedAtDesc).slice(0, input.limit ?? 50),
    touch: async (id: string): Promise<void> => {
      const conversation = this.conversationRecords.get(id);
      if (conversation) this.conversationRecords.set(id, { ...conversation, updatedAt: new Date().toISOString() });
    },
    delete: async (id: string): Promise<boolean> => {
      const deleted = this.conversationRecords.delete(id);
      this.messageRecords.delete(id);
      return deleted;
    }
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
        createdAt: now
      };
      this.messageRecords.set(input.conversationId, [...(this.messageRecords.get(input.conversationId) ?? []), message]);
      const conversation = this.conversationRecords.get(input.conversationId);
      if (conversation) this.conversationRecords.set(conversation.id, { ...conversation, updatedAt: now });
      return message;
    },
    listByConversationId: async (conversationId: string): Promise<MessageRecord[]> => [...(this.messageRecords.get(conversationId) ?? [])]
  };

  readonly runs = {
    create: async (input: RunRecord): Promise<RunRecord> => {
      this.runRecords.set(input.id, input);
      return input;
    },
    findById: async (id: string): Promise<RunRecord | null> => this.runRecords.get(id) ?? null,
    list: async (input: { limit?: number } = {}): Promise<RunRecord[]> =>
      [...this.runRecords.values()].sort(byUpdatedAtDesc).slice(0, input.limit ?? 100),
    updateStatus: async (id: string, status: RunStatus, completedAt?: string): Promise<void> => {
      const run = this.runRecords.get(id);
      if (!run) return;
      this.runRecords.set(id, { ...run, status, completedAt, updatedAt: new Date().toISOString() });
    },
    updateContext: async (id: string, context: Record<string, unknown>): Promise<void> => {
      const run = this.runRecords.get(id);
      if (!run) return;
      this.runRecords.set(id, { ...run, context, updatedAt: new Date().toISOString() });
    }
  };

  readonly events = {
    append: async (event: SunPilotEvent): Promise<SunPilotEvent> => {
      this.eventRecords.push(event);
      return event;
    },
    listByRunId: async (runId: string): Promise<SunPilotEvent[]> =>
      this.eventRecords.filter((event) => event.runId === runId).sort(byCreatedAt)
  };

  readonly steps = {
    create: async (input: StepRecord): Promise<StepRecord> => {
      this.stepRecords.set(input.id, input);
      return input;
    },
    listByRunId: async (runId: string): Promise<StepRecord[]> =>
      [...this.stepRecords.values()].filter((step) => step.runId === runId),
    updateStatus: async (stepId: string, status: StepStatus, output?: unknown, error?: unknown): Promise<void> => {
      const step = this.stepRecords.get(stepId);
      if (!step) return;
      this.stepRecords.set(stepId, {
        ...step,
        status,
        output: output === undefined ? step.output : output,
        error: error === undefined ? step.error : error,
        completedAt: ["completed", "failed", "skipped", "canceled", "interrupted"].includes(status) ? new Date().toISOString() : step.completedAt
      });
    }
  };

  readonly approvals = {
    create: async (input: ApprovalRecord): Promise<ApprovalRecord> => {
      this.approvalRecords.set(input.id, input);
      return input;
    },
    decide: async (id: string, status: "approved" | "rejected", decision: unknown): Promise<ApprovalRecord | null> => {
      const approval = this.approvalRecords.get(id);
      if (!approval) return null;
      if (approval.status !== "pending") return approval;
      const updated = { ...approval, status, decision, decidedAt: new Date().toISOString() };
      this.approvalRecords.set(id, updated);
      return updated;
    },
    findById: async (id: string): Promise<ApprovalRecord | null> => this.approvalRecords.get(id) ?? null,
    list: async (): Promise<ApprovalRecord[]> => [...this.approvalRecords.values()].sort(byCreatedAt)
  };

  readonly artifacts = {
    create: async (input: ArtifactRecord): Promise<ArtifactRecord> => {
      this.artifactRecords.set(input.id, input);
      return input;
    },
    findById: async (id: string): Promise<ArtifactRecord | null> => this.artifactRecords.get(id) ?? null,
    list: async (runId?: string): Promise<ArtifactRecord[]> =>
      [...this.artifactRecords.values()].filter((artifact) => !runId || artifact.runId === runId).sort(byCreatedAt)
  };

  readonly memory = {
    create: async (input: MemoryRecord): Promise<MemoryRecord> => {
      this.memoryRecords.push(input);
      return input;
    },
    list: async (input: { runId?: string; key?: string } = {}): Promise<MemoryRecord[]> =>
      this.memoryRecords
        .filter((memory) => !input.runId || memory.runId === input.runId)
        .filter((memory) => !input.key || memory.key === input.key)
        .sort(byCreatedAt)
  };

  readonly settings = {
    set: async (key: string, value: unknown): Promise<SettingRecord> => {
      const setting = { key, value, updatedAt: new Date().toISOString() };
      this.settingRecords.set(key, setting);
      return setting;
    },
    get: async (key: string): Promise<SettingRecord | null> => this.settingRecords.get(key) ?? null
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
        createdAt: input.createdAt ?? new Date().toISOString()
      };
      this.auditRecords.push(record);
      return record;
    },
    list: async (runId?: string): Promise<AuditRecord[]> =>
      this.auditRecords.filter((record) => !runId || record.runId === runId).sort(byCreatedAt)
  };

  readonly jobs = {
    create: async (input: CreateJobInput): Promise<JobRecord> => {
      const now = new Date().toISOString();
      const job = { ...input, attempts: input.attempts ?? 0, createdAt: now, updatedAt: now };
      this.jobRecords.set(job.id, job);
      return job;
    },
    updateStatus: async (runId: string, status: string, incrementAttempts = false): Promise<void> => {
      for (const job of this.jobRecords.values()) {
        if (job.runId !== runId) continue;
        this.jobRecords.set(job.id, {
          ...job,
          status,
          attempts: incrementAttempts ? job.attempts + 1 : job.attempts,
          updatedAt: new Date().toISOString()
        });
      }
    },
    list: async (runId?: string): Promise<JobRecord[]> =>
      [...this.jobRecords.values()].filter((job) => !runId || job.runId === runId).sort(byCreatedAt),
    expireTimedOut: async (now = new Date().toISOString()): Promise<string[]> => {
      const expiredRunIds: string[] = [];
      for (const job of this.jobRecords.values()) {
        if (job.timeoutAt && job.timeoutAt <= now && !["completed", "failed", "canceled", "interrupted", "timed_out"].includes(job.status)) {
          this.jobRecords.set(job.id, { ...job, status: "timed_out", attempts: job.attempts + 1, updatedAt: now });
          expiredRunIds.push(job.runId);
        }
      }
      return expiredRunIds;
    }
  };

  readonly workflows = {
    upsert: async (input: WorkflowRecord): Promise<WorkflowRecord> => {
      this.workflowRecords.set(input.id, input);
      return input;
    },
    list: async (): Promise<WorkflowRecord[]> => [...this.workflowRecords.values()].sort((left, right) => left.id.localeCompare(right.id)),
    findById: async (id: string): Promise<WorkflowRecord | null> => this.workflowRecords.get(id) ?? null
  };

  readonly skills = {
    upsert: async (input: InstalledSkillRecord): Promise<InstalledSkillRecord> => {
      this.skillRecords.set(input.id, input);
      return input;
    },
    list: async (): Promise<InstalledSkillRecord[]> => [...this.skillRecords.values()].sort((left, right) => left.id.localeCompare(right.id)),
    findById: async (id: string): Promise<InstalledSkillRecord | null> => this.skillRecords.get(id) ?? null,
    setEnabled: async (id: string, enabled: boolean): Promise<InstalledSkillRecord | null> => {
      const skill = this.skillRecords.get(id);
      if (!skill) return null;
      const updated = { ...skill, enabled, updatedAt: new Date().toISOString() };
      this.skillRecords.set(id, updated);
      return updated;
    }
  };

  reset(): void {
    this.conversationRecords.clear();
    this.messageRecords.clear();
    this.runRecords.clear();
    this.eventRecords.length = 0;
    this.stepRecords.clear();
    this.approvalRecords.clear();
    this.artifactRecords.clear();
    this.memoryRecords.length = 0;
    this.settingRecords.clear();
    this.auditRecords.length = 0;
    this.jobRecords.clear();
    this.workflowRecords.clear();
    this.skillRecords.clear();
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}
