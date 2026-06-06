import type { ApprovalRecord } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import type { AgentEvent } from "../agent-event-bus.js";
import type { RiskLevel } from "../loop-types.js";
import {
  APPROVAL_EXPIRY_MINUTES,
  type Permission,
} from "../safety/safety-types.js";
import { RepositoryRunStateManager } from "./repository-run-state-manager.js";

export interface ApprovalRequestInput {
  runId: string;
  conversationId?: string;
  stepId?: string;
  toolCallId?: string;
  title: string;
  description: string;
  riskLevel: RiskLevel;
  requestedAction: {
    skillId: string;
    arguments: Record<string, unknown>;
    permissions: Permission[];
  };
}

export interface ApprovalRequestResult {
  approval: { id: string; status: string };
  event: AgentEvent;
}

export class RepositoryApprovalRequestService {
  constructor(private readonly db: DatabaseContext) {}

  async requestApproval(
    input: ApprovalRequestInput,
  ): Promise<ApprovalRequestResult> {
    const work = async (database: DatabaseContext) => {
      const runStateManager = new RepositoryRunStateManager(database);
      await runStateManager.markStatus(
        input.runId,
        "waiting_approval",
        `awaiting approval for ${input.title}`,
      );

      const now = new Date().toISOString();
      const expiryMinutes = APPROVAL_EXPIRY_MINUTES[input.riskLevel] ?? 30;
      const approval: ApprovalRecord = {
        id: `approval_${crypto.randomUUID()}`,
        runId: input.runId,
        stepId: input.stepId,
        status: "pending",
        risk: input.riskLevel,
        title: input.title,
        reason: input.description,
        requestedAction: {
          ...input.requestedAction,
          toolCallId: input.toolCallId,
        },
        createdAt: now,
        expiresAt:
          expiryMinutes > 0
            ? new Date(Date.now() + expiryMinutes * 60_000).toISOString()
            : undefined,
      };
      const created = await database.approvals.create(approval);
      const event: AgentEvent = {
        id: `evt_${crypto.randomUUID()}`,
        type: "agent.approval.required",
        runId: input.runId,
        conversationId: input.conversationId,
        payload: {
          runId: input.runId,
          approvalId: created.id,
          title: input.title,
          riskLevel: input.riskLevel,
        },
        createdAt: now,
      };
      const persisted = await database.events.append({
        id: event.id,
        runId: input.runId,
        conversationId: input.conversationId,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      });

      return {
        approval: { id: created.id, status: created.status },
        event: {
          ...event,
          sequence: persisted.sequence,
        },
      };
    };

    return this.db.transaction ? this.db.transaction(work) : work(this.db);
  }
}
