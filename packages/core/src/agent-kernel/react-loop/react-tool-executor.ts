import type { AgentEventBus } from "../agent-event-bus.js";
import type {
  AgentContext,
  ArtifactRef,
  ExecutionOrchestrator,
  IAssistantMessageStream,
  PermissionMode,
  PlannedToolCall,
  ToolCallSummary,
} from "../loop-types.js";

/** Executes a validated ReAct action batch and projects lifecycle events. */
export class ReactToolExecutor {
  constructor(
    private readonly executionOrchestrator: ExecutionOrchestrator,
    private readonly eventBus: AgentEventBus,
  ) {}

  async execute(input: {
    runId: string;
    conversationId: string;
    context: AgentContext;
    calls: PlannedToolCall[];
    permissionMode: PermissionMode;
    stream?: IAssistantMessageStream;
    approvedTools?: Array<{
      toolCallId: string;
      skillId: string;
      arguments: Record<string, unknown>;
      grantedBy?: string;
    }>;
    toolPartsPresent?: boolean;
  }, signal: AbortSignal): Promise<{
    summaries: ToolCallSummary[];
    artifacts: ArtifactRef[];
  }> {
    const statusIds = new Map<string, string>();
    for (const call of input.calls) {
      this.eventBus.emit(
        "agent.tool.selected",
        {
          runId: input.runId,
          toolCallId: call.id,
          skillId: call.skillId,
          name: call.name,
          riskLevel: call.riskLevel,
        },
        { runId: input.runId, conversationId: input.conversationId },
      );
      if (input.stream && !input.toolPartsPresent) {
        const status = input.stream.startStatus({
          label: `正在调用工具: ${call.name}`,
          toolCallId: call.id,
          metadata: { skillId: call.skillId, phase: "running" },
        });
        statusIds.set(call.id, status.id);
        input.stream.addToolUse({
          toolCallId: call.id,
          skillId: call.skillId,
          name: call.name,
          inputPreview: call.arguments,
        });
        input.stream.updateToolUse(call.id, { status: "running" });
      } else if (input.stream) {
        input.stream.updateToolUse(call.id, { status: "running" });
      }
    }

    const observation = await this.executionOrchestrator.execute(
      {
        runId: input.runId,
        context: input.context,
        calls: input.calls,
        permissionMode: input.permissionMode,
        approvedTools: input.approvedTools,
      },
      signal,
    );

    for (const summary of observation.toolCalls) {
      const ok = summary.status === "completed";
      this.eventBus.emit(
        ok ? "agent.tool.completed" : "agent.tool.failed",
        {
          runId: input.runId,
          toolCallId: summary.id,
          skillId: summary.skillId,
          summary: summary.summary,
          artifacts: observation.artifacts.map((artifact) => artifact.id),
        },
        { runId: input.runId, conversationId: input.conversationId },
      );
      if (input.stream) {
        const statusId = statusIds.get(summary.id);
        if (statusId) {
          input.stream.updateStatus(statusId, {
            status: ok ? "completed" : "failed",
            label: ok ? `完成: ${summary.name}` : `失败: ${summary.name}`,
          });
        }
        input.stream.updateToolUse(summary.id, {
          status: ok ? "completed" : "failed",
        });
        input.stream.addToolResult({
          toolCallId: summary.id,
          skillId: summary.skillId,
          summary: summary.summary,
          artifactIds: observation.artifacts.map((artifact) => artifact.id),
          trust: ok ? "trusted" : "untrusted",
        });
      }
    }

    return {
      summaries: observation.toolCalls,
      artifacts: observation.artifacts,
    };
  }
}
