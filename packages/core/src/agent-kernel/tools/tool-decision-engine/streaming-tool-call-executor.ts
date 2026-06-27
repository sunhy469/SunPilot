import type { LlmProvider } from "../../../llm/llm.provider.js";
import type {
  AgentContext,
  AgentPlan,
  AgentObservation,
  ArtifactRef,
  ExecutionOrchestrator,
  IAssistantMessageStream,
  PermissionPolicy,
  PlannedToolCall,
  RoutedIntent,
  ToolCallSummary,
  ToolDecision,
  ToolDecisionEngine as ToolDecisionEngineInterface,
} from "../../loop-types.js";
import { INTENT_SKILL_MAP, type SkillSummary } from "../tool-types.js";
import type { ToolArgumentBuilder } from "../tool-argument-builder.js";
import type {
  ToolRetriever,
  ToolRetrievalResult,
  ToolCallHistoryEntry,
} from "../tool-retriever.js";
import type { EmbeddingService } from "../../context/embedding-service.js";
import type { AgentEventBus } from "../../agent-event-bus.js";
import { DeltaThrottle } from "../../agent-event-bus.js";
import type { ModelRouter } from "../../model-router.js";
import { checkAnyOfUnsatisfied } from "../tool-schema-utils.js";
import { RichCardBuilder } from "../rich-card-builder.js";
import { MARKDOWN_RESPONSE_POLICY } from "../markdown-response-policy.js";
import {
  buildStreamingToolDefinitions,
} from "./tool-definition-builder.js";
import {
  buildToolArgumentsHeuristic,
  canonicalizeArgs,
} from "./tool-argument-normalizer.js";
import {
  injectStreamingToolResults,
  projectToolResultForModel,
} from "./tool-result-projector.js";
import {
  attachTrace,
  capabilityNameFromToolId,
  clampConfidence,
  computeMaxIterations,
  deriveRecentHistory,
  maxRisk,
  scoreSkills,
  stableStringifyArgs,
  summarizeForPreview,
} from "./selection-utils.js";
import { parseTextualFunctionCalls } from "./textual-function-call-parser.js";
import type {
  DecisionMetadata,
  LlmToolDecision,
  ScoredSkill,
  ToolCallAccumulator,
  ToolLoopStopReason,
} from "./types.js";

import type {
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from "../../../llm/llm.types.js";
import type { ToolDecisionEngineDeps } from "../tool-decision-engine.js";

/** Validates and executes one LLM-produced batch of tool calls. */
export class StreamingToolCallExecutor {
  constructor(private readonly deps: ToolDecisionEngineDeps) {}

  /**
   * Execute tool calls from the LLM.
   * Validates arguments, checks permissions, and runs execution.
   */
  async execute(
    runId: string,
    conversationId: string,
    toolCalls: ToolCall[],
    toolNameMap: Map<string, string>,
    context: AgentContext,
    intent: RoutedIntent,
    allSkills: SkillSummary[],
    signal: AbortSignal,
    stream?: IAssistantMessageStream,
    permissionMode?: "ask" | "auto" | "full",
  ): Promise<{
    artifacts: ArtifactRef[];
    summaries: ToolCallSummary[];
    /** When set, the tool loop must stop immediately (deterministic error). */
    stop?: {
      reason: ToolLoopStopReason;
      message: string;
    };
  }> {
    const artifacts: ArtifactRef[] = [];
    const summaries: ToolCallSummary[] = [];

    // §4.1: Multi-tool parallel execution.
    // Phase 1 (sequential): parse args, find skill, validate, check permissions.
    //   Permission/approval gates are safety-critical and stay serial.
    // Phase 2 (parallel): execute all validated tools with Promise.allSettled.
    // Phase 3 (sequential): process results, emit events in original order.
    interface ExecutionTask {
      tc: ToolCall;
      skill: SkillSummary;
      plannedCall: PlannedToolCall;
      statusPartId?: string;
      onProgress?: (progress: { phase: string; message: string; percent?: number }) => void;
    }
    const executionTasks: ExecutionTask[] = [];

    for (const tc of toolCalls) {
      // Parse arguments
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        const failSummary: ToolCallSummary = {
          id: tc.id,
          skillId: tc.function.name,
          name: tc.function.name,
          status: "failed",
          summary: `Failed to parse tool arguments: ${tc.function.arguments.slice(0, 200)}`,
        };
        summaries.push(failSummary);
        if (stream) {
          stream.addError({
            message: failSummary.summary,
            code: "TOOL_ARGUMENT_PARSE_FAILED",
            recoverable: true,
          });
        }
        continue;
      }

      const skillId = toolNameMap.get(tc.function.name) ?? tc.function.name;

      // Find the skill in full skill catalog
      const skill = allSkills.find((s) => s.id === skillId);
      if (!skill) {
        const failSummary: ToolCallSummary = {
          id: tc.id,
          skillId,
          name: skillId,
          status: "failed",
          summary: `Unknown tool: ${skillId}. Available tools: ${allSkills.map((s) => s.id).join(", ")}`,
        };
        summaries.push(failSummary);
        if (stream) {
          stream.addError({
            message: failSummary.summary,
            code: "TOOL_UNKNOWN",
            recoverable: true,
          });
        }
        continue;
      }

      // Emit tool.selected
      this.deps.eventBus.emit(
        "agent.tool.selected",
        {
          runId,
          toolCallId: tc.id,
          skillId: skill.id,
          name: skill.name,
          riskLevel: "medium",
        },
        { runId, conversationId },
      );

      // Start status part via stream (§Phase 3)
      let statusPartId: string | undefined;
      if (stream) {
        const statusPart = stream.startStatus({
          label: `正在调用工具: ${skill.name}`,
          toolCallId: tc.id,
          metadata: { skillId: skill.id },
        });
        statusPartId = statusPart.id;
      }

      // Add tool_use part via stream (§P1-3: status lifecycle)
      if (stream) {
        stream.addToolUse({
          toolCallId: tc.id,
          skillId: skill.id,
          name: skill.name,
          inputPreview:
            Object.keys(parsedArgs).length > 0
              ? summarizeForPreview(parsedArgs)
              : undefined,
        });
        // Now that execution is starting, update status to running
        stream.updateToolUse(tc.id, { status: "running" });
      }

      // ── Argument validation gate (§5.4) ──────────────────────────
      let finalArgs = canonicalizeArgs(parsedArgs);
      let argumentSources: PlannedToolCall["argumentSources"] = [];
      if (this.deps.argumentBuilder && skill.inputSchema) {
        try {
          const built = await this.deps.argumentBuilder.build(
            {
              context,
              intent,
              skill,
              schema: skill.inputSchema,
            },
            signal,
          );
          finalArgs = { ...finalArgs, ...built.arguments };
          argumentSources = built.sources;

          const anyOfUnsatisfied = checkAnyOfUnsatisfied(
            finalArgs,
            skill.inputSchema,
          );
          const hasMissingArgs = built.missing.length > 0 || anyOfUnsatisfied;

          if (hasMissingArgs) {
            // Try repair once
            try {
              const validationErrors = built.missing.map(
                (f) => `Missing required field: ${f}`,
              );
              const repaired = await this.deps.argumentBuilder.repair(
                {
                  skillId: skill.id,
                  name: skill.name,
                  currentArgs: finalArgs,
                  schema: skill.inputSchema,
                  validationErrors,
                },
                signal,
              );
              finalArgs = { ...finalArgs, ...repaired.arguments };

              const postRepairCheck = await this.deps.argumentBuilder.build(
                { context, intent, skill, schema: skill.inputSchema },
                signal,
              );
              const postAnyOfUnsatisfied = checkAnyOfUnsatisfied(
                { ...finalArgs, ...repaired.arguments },
                skill.inputSchema,
              );
              if (postRepairCheck.missing.length > 0 || postAnyOfUnsatisfied) {
                const missingFields = postRepairCheck.missing.join(", ");
                const failSummary: ToolCallSummary = {
                  id: tc.id,
                  skillId: skill.id,
                  name: skill.name,
                  status: "failed",
                  summary: `Missing required arguments: ${missingFields}`,
                };
                summaries.push(failSummary);
                if (stream) {
                  if (statusPartId) {
                    stream.updateStatus(statusPartId, {
                      status: "failed",
                      label: `失败: ${skill.name} (缺少参数)`,
                    });
                  }
                  stream.updateToolUse(tc.id, { status: "failed" });
                  stream.addError({
                    message: `我还没有拿到可用于搜索的图片链接。请等待图片上传完成，或重新上传图片后我再继续搜索。`,
                    code: "TOOL_ARGUMENT_MISSING",
                    recoverable: true,
                  });
                }
                return {
                  artifacts,
                  summaries,
                  stop: {
                    reason: "missing_required_arguments",
                    message:
                      "缺少可用图片引用，不能执行搜索。请上传图片后重试，或确认图片已上传完成。",
                  },
                };
              }
            } catch {
              // Repair failed — fall through and try execution anyway
            }
          }
        } catch {
          // Continue with canonicalized args if builder fails
        }
      }

      // Build a PlannedToolCall for execution
      const skillRisk = skill.riskHints?.defaultRisk ?? "medium";
      const plannedCall: PlannedToolCall = {
        id: tc.id,
        skillId: skill.id,
        name: skill.name,
        arguments: finalArgs,
        permissions: skill.permissions,
        reason: `LLM function calling selected ${skill.name}`,
        riskLevel: skillRisk,
        requiresApproval: skillRisk === "high" || skillRisk === "critical",
        timeoutMs: skill.defaultTimeoutMs || 60_000,
        riskHints: {
          defaultRisk: skillRisk,
        },
        argumentSources,
      };

      // Check permissions
      if (plannedCall.permissions && plannedCall.permissions.length > 0) {
        const permDecision = await this.deps.permissionPolicy.evaluate({
          userId: context.userId,
          runId,
          skillId: skill.id,
          permissions: plannedCall.permissions,
          arguments: finalArgs,
          context,
          permissionMode: permissionMode ?? "auto",
          riskHints: plannedCall.riskHints,
        });

        if (!permDecision.allowed) {
          const failSummary: ToolCallSummary = {
            id: tc.id,
            skillId: skill.id,
            name: skill.name,
            status: "failed",
            summary: `Permission denied: ${permDecision.reasons.join(", ")}`,
          };
          summaries.push(failSummary);
          if (stream && statusPartId) {
            stream.updateStatus(statusPartId, {
              status: "failed",
              label: `失败: ${skill.name} (权限不足)`,
            });
            stream.updateToolUse(tc.id, { status: "failed" });
          }
          return {
            artifacts,
            summaries,
            stop: {
              reason: "permission_denied",
              message: `工具 ${skill.name} 缺少必要权限，无法执行。`,
            },
          };
        }

        if (permDecision.requiresApproval) {
          const failSummary: ToolCallSummary = {
            id: tc.id,
            skillId: skill.id,
            name: skill.name,
            status: "failed",
            summary: `Approval required for ${skill.name}`,
          };
          summaries.push(failSummary);
          if (stream && statusPartId) {
            stream.updateStatus(statusPartId, {
              status: "failed",
              label: `需要审批: ${skill.name}`,
            });
            stream.updateToolUse(tc.id, { status: "failed" });
          }
          return {
            artifacts,
            summaries,
            stop: {
              reason: "permission_denied",
              message: `工具 ${skill.name} 需要审批后才能执行。`,
            },
          };
        }
      }

      // Emit tool.started and collect for parallel execution (§4.1)
      this.deps.eventBus.emit(
        "agent.tool.started",
        { runId, toolCallId: tc.id, skillId: skill.id, name: skill.name },
        { runId, conversationId },
      );

      // §P1-4: Bridge tool progress to stream status part metadata
      const onProgress =
        stream && statusPartId
          ? (progress: {
              phase: string;
              message: string;
              percent?: number;
            }) => {
              stream!.updateStatus(statusPartId!, {
                label: progress.message,
                metadata: {
                  skillId: skill.id,
                  phase: progress.phase as
                    | "queued"
                    | "running"
                    | "polling"
                    | "completed",
                  progress: progress.percent,
                },
              });
            }
          : undefined;

      executionTasks.push({ tc, skill, plannedCall, statusPartId, onProgress });
    }

    // §4.1 Phase 2: Execute all prepared tools in parallel.
    // Multi-tool latency goes from sum(latencies) → max(latencies).
    // Each tool's abort signal is respected — if signal aborts, pending
    // executions are rejected by Promise.allSettled.
    if (executionTasks.length > 0) {
      const execResults = await Promise.allSettled(
        executionTasks.map((task) =>
          this.deps.executionOrchestrator.execute(
            {
              runId,
              context,
              intent: {
                type: "use_skill",
                confidence: 1,
                requiresPlanning: false,
                requiresTool: true,
                requiresApproval: false,
                riskLevel: "medium",
                candidateSkills: [task.skill.id],
                reason: "LLM function calling",
              },
              decision: {
                type: "use_tool",
                reason: `LLM called ${task.skill.name}`,
                toolCalls: [task.plannedCall],
              },
              onProgress: task.onProgress as
                | ((p: import("../../loop-types.js").ToolExecutionProgress) => void)
                | undefined,
            },
            signal,
          ),
        ),
      );

      // §4.1 Phase 3: Process results sequentially in original order
      for (let i = 0; i < executionTasks.length; i++) {
        const task = executionTasks[i]!;
        const result = execResults[i]!;

        if (result.status === "fulfilled") {
          const observation = result.value;
          for (const summary of observation.toolCalls) {
            summaries.push(summary);
            this.deps.eventBus.emit(
              summary.status === "completed"
                ? "agent.tool.completed"
                : "agent.tool.failed",
              {
                runId,
                toolCallId: summary.id,
                skillId: summary.skillId,
                summary: summary.summary,
                artifacts: observation.artifacts.map((a) => a.id),
              },
              { runId, conversationId },
            );

            if (stream && task.statusPartId) {
              const ok = summary.status === "completed";
              stream.updateStatus(task.statusPartId, {
                status: ok ? "completed" : "failed",
                label: ok ? `完成: ${task.skill.name}` : `失败: ${task.skill.name}`,
              });
              stream.updateToolUse(summary.id, {
                status: ok ? "completed" : "failed",
              });
              stream.addToolResult({
                toolCallId: summary.id,
                skillId: summary.skillId,
                summary: summary.summary,
                artifactIds: observation.artifacts.map((a) => a.id),
                trust: summary.status === "completed" ? "trusted" : "untrusted",
              });
            }
          }

          artifacts.push(...observation.artifacts);

          for (const artifact of observation.artifacts) {
            this.deps.eventBus.emit(
              "agent.artifact.created",
              {
                runId,
                artifactId: artifact.id,
                name: artifact.name,
                type: artifact.type,
                version: artifact.version,
              },
              { runId, conversationId },
            );
          }
        } else {
          const errMsg =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          const failSummary: ToolCallSummary = {
            id: task.tc.id,
            skillId: task.skill.id,
            name: task.skill.name,
            status: "failed",
            summary: `Execution error: ${errMsg}`,
          };
          summaries.push(failSummary);
          this.deps.eventBus.emit(
            "agent.tool.failed",
            {
              runId,
              toolCallId: task.tc.id,
              skillId: task.skill.id,
              error: { code: "AGENT_TOOL_EXECUTION_FAILED", message: errMsg },
            },
            { runId },
          );
          if (stream && task.statusPartId) {
            stream.updateStatus(task.statusPartId, {
              status: "failed",
              label: `执行失败: ${task.skill.name}`,
            });
            stream.updateToolUse(task.tc.id, { status: "failed" });
            stream.addError({
              message: errMsg,
              code: "AGENT_TOOL_EXECUTION_FAILED",
              recoverable: true,
            });
          }
        }
      }
    }

    return { artifacts, summaries };
  }
}
