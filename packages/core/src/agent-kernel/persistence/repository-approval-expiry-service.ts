import {
  AuditActor,
  type ApprovalRecord,
  type SunPilotEvent,
} from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import type { AgentEventBus } from "../agent-event-bus.js";
import { RUN_PHASE_LABELS } from "../agent-loop-engine.js";
import { RepositoryRunStateManager } from "./repository-run-state-manager.js";

export interface ExpiredApprovalResult {
  approvalId: string;
  runId: string;
  runCancelled: boolean;
}

export class RepositoryApprovalExpiryService {
  constructor(
    private readonly db: DatabaseContext,
    private readonly eventBus?: AgentEventBus,
  ) {}

  async expireStale(
    now = new Date().toISOString(),
  ): Promise<ExpiredApprovalResult[]> {
    const results: ExpiredApprovalResult[] = [];

    while (true) {
      const stale = await this.db.approvals.list({
        status: "pending",
        expiresBefore: now,
        limit: 200,
      });
      if (stale.length === 0) break;

      for (const approval of stale) {
        if (!isExpired(approval, now)) continue;
        const process = (database: DatabaseContext) =>
          this.expireOne(database, approval.id, now);
        const outcome = this.db.transaction
          ? await this.db.transaction(process)
          : await process(this.db);
        if (!outcome) continue;
        for (const event of outcome.events) this.publishPersisted(event);
        results.push(outcome.result);
      }
    }

    return results;
  }

  private async expireOne(
    database: DatabaseContext,
    approvalId: string,
    now: string,
  ): Promise<{
    result: ExpiredApprovalResult;
    events: SunPilotEvent[];
  } | undefined> {
    const expired = await database.approvals.expire(approvalId);
    if (!expired || expired.status !== "expired") return undefined;

    const events: SunPilotEvent[] = [];
    const runStateManager = new RepositoryRunStateManager(database);
    const run = await database.runs.findById(expired.runId);
    let runCancelled = false;
    if (run?.status === "waiting_approval") {
      await runStateManager.markCancelled(
        expired.runId,
        `approval expired: ${expired.id}`,
      );
      runCancelled = true;
    }

    await database.audit.create({
      runId: expired.runId,
      stepId: expired.stepId,
      actor: AuditActor.Daemon,
      action: "approval.expired",
      target: expired.id,
      risk: expired.risk,
      payload: {
        approvalId: expired.id,
        title: expired.title,
        expiresAt: expired.expiresAt,
      },
      createdAt: now,
    });

    const runState = await runStateManager.getRun(expired.runId);
    const gatheredFacts = runState?.taskState?.gatheredFacts as
      | Record<string, unknown>
      | undefined;
    const partsSnapshot = gatheredFacts?.partsSnapshot as
      | Array<{ id: string; type: string; status?: string; label?: string }>
      | undefined;
    const approvalMessageId = gatheredFacts?.approvalMessageId as string | undefined;
    if (approvalMessageId && partsSnapshot) {
      const updatedParts = partsSnapshot.map((part) => terminalExpiredPart(part, now));
      for (const part of partsSnapshot) {
        if (!isWaitingApprovalStatus(part)) continue;
        events.push(await database.events.append({
          id: `evt_${crypto.randomUUID()}`,
          runId: expired.runId,
          conversationId: run?.conversationId,
          type: "agent.message.part.updated",
          payload: {
            runId: expired.runId,
            conversationId: run?.conversationId,
            messageId: approvalMessageId,
            partId: part.id,
            patch: {
              status: "failed",
              label: expiredStatusLabel(part.label!),
            },
          },
          createdAt: now,
        }));
      }
      if (run?.conversationId) {
        const messages = await database.messages.listByConversationId(run.conversationId);
        const existing = messages.find((message) => message.id === approvalMessageId);
        if (existing) {
          await database.messages.create({
            id: existing.id,
            conversationId: run.conversationId,
            role: "assistant",
            content: existing.content,
            metadata: { ...existing.metadata, parts: updatedParts },
          });
        }
      }
    }

    events.push(await database.events.append({
      id: `evt_${crypto.randomUUID()}`,
      runId: expired.runId,
      conversationId: run?.conversationId,
      type: "agent.approval.expired",
      payload: {
        runId: expired.runId,
        approvalId: expired.id,
        title: expired.title,
        riskLevel: expired.risk,
        runCancelled,
      },
      createdAt: now,
    }));
    if (runCancelled) {
      events.push(await database.events.append({
        id: `evt_${crypto.randomUUID()}`,
        runId: expired.runId,
        conversationId: run?.conversationId,
        type: "agent.run.cancelled",
        payload: {
          runId: expired.runId,
          reason: `approval expired: ${expired.id}`,
        },
        createdAt: now,
      }));
    }
    return {
      result: { approvalId: expired.id, runId: expired.runId, runCancelled },
      events,
    };
  }

  private publishPersisted(event: SunPilotEvent): void {
    this.eventBus?.publish({
      id: event.id,
      type: event.type,
      runId: event.runId,
      conversationId: event.conversationId,
      sequence: event.sequence,
      payload: event.payload as Record<string, unknown>,
      createdAt: event.createdAt,
    });
  }
}

function isExpired(approval: ApprovalRecord, now: string): boolean {
  return !!approval.expiresAt && new Date(approval.expiresAt) <= new Date(now);
}

function isWaitingApprovalStatus(part: {
  type: string;
  status?: string;
  label?: string;
}): boolean {
  return part.type === "status" &&
    part.status === "running" &&
    !!part.label?.startsWith(RUN_PHASE_LABELS.waiting_approval);
}

function expiredStatusLabel(label: string): string {
  return `确认已过期: ${label.replace(`${RUN_PHASE_LABELS.waiting_approval}: `, "")}`;
}

function terminalExpiredPart<T extends {
  type: string;
  status?: string;
  label?: string;
}>(part: T, now: string): T & Record<string, unknown> {
  if (isWaitingApprovalStatus(part)) {
    return {
      ...part,
      status: "failed",
      label: expiredStatusLabel(part.label!),
      completedAt: now,
    };
  }
  if (
    part.type === "tool_use" &&
    (part.status === "pending" || part.status === "running")
  ) {
    return { ...part, status: "interrupted" };
  }
  return part;
}
