import type { AgentEventBus } from "../agent-event-bus.js";
import type { ToolCallRepository } from "@sunpilot/storage";
import type {
  AgentContext,
  AgentObservation,
  ArtifactRef,
  ExecutionOrchestrator as ExecutionOrchestratorInterface,
  IntentRouter,
  ToolCallSummary,
  ToolDecision,
} from "../loop-types.js";
import {
  DEFAULT_CONCURRENCY,
  MAX_RETRIES,
  RETRY_BACKOFF,
  isRetryable,
  type ToolExecutor,
} from "./execution-types.js";

export interface ExecutionOrchestratorDeps {
  /** Executor that actually runs tools (bridges to skill-runner). */
  toolExecutor: ToolExecutor;
  /** Event bus for emitting tool events. */
  eventBus: AgentEventBus;
  /** Durable audit log for tool invocations. */
  toolCalls?: ToolCallRepository;
}

/**
 * ExecutionOrchestrator — 工具调用执行编排器。
 *
 * 核心能力：
 * - 并发控制：按 skillId 类别分组（filesystem.read 可并发，shell.execute 串行）
 * - 重试逻辑：最多 MAX_RETRIES 次，指数退避（RETRY_BACKOFF），仅可重试错误才重试
 * - 事件发射：tool.started → tool.completed / tool.failed
 * - 制品追踪：收集所有工具返回的 artifacts
 *
 * 内部包装 skill-runner 包，通过 ToolExecutor 接口解耦。
 * 架构文档 §17。
 */
export class ExecutionOrchestrator implements ExecutionOrchestratorInterface {
  constructor(private readonly deps: ExecutionOrchestratorDeps) {}

  async execute(
    input: {
      runId: string;
      context: AgentContext;
      intent: ReturnType<IntentRouter["route"]> extends Promise<infer T>
        ? T
        : never;
      plan?: import("../loop-types.js").AgentPlan;
      decision: ToolDecision & { type: "use_tool" };
    },
    signal: AbortSignal,
  ): Promise<AgentObservation> {
    const { runId, context, decision } = input;
    const toolCalls = decision.toolCalls;
    const results: ToolCallSummary[] = [];
    const allArtifacts: ArtifactRef[] = [];

    // Group tool calls by category for concurrency control
    const groups = this.groupByConcurrency(toolCalls);

    for (const [category, calls] of groups) {
      const maxConcurrent = DEFAULT_CONCURRENCY[category] ?? 1;

      if (maxConcurrent === 1 || calls.length === 1) {
        // Serial execution
        for (const call of calls) {
          if (signal.aborted) break;
          const result = await this.executeWithRetry(
            runId,
            context.conversationId,
            call,
            signal,
          );
          results.push(result.summary);
          allArtifacts.push(...result.artifacts);
        }
      } else {
        // Parallel execution within concurrency limit
        const chunks = this.chunkArray(calls, maxConcurrent);
        for (const chunk of chunks) {
          if (signal.aborted) break;
          const chunkResults = await Promise.all(
            chunk.map((call) =>
              signal.aborted
                ? Promise.resolve(null)
                : this.executeWithRetry(
                    runId,
                    context.conversationId,
                    call,
                    signal,
                  ),
            ),
          );
          for (const r of chunkResults) {
            if (!r) continue;
            results.push(r.summary);
            allArtifacts.push(...r.artifacts);
          }
        }
      }
    }

    return {
      runId,
      toolCalls: results,
      artifacts: allArtifacts,
      summary: results.map((r) => r.summary).join("\n"),
    };
  }

  private async executeWithRetry(
    runId: string,
    conversationId: string,
    call: {
      id: string;
      skillId: string;
      name: string;
      arguments: Record<string, unknown>;
      riskLevel: string;
      timeoutMs: number;
    },
    signal: AbortSignal,
  ): Promise<{
    summary: ToolCallSummary;
    artifacts: ArtifactRef[];
  }> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Emit tool.started event
        await this.deps.toolCalls?.create({
          id: call.id,
          runId,
          skillId: call.skillId,
          name: call.name,
          arguments: call.arguments,
          status: "running",
          riskLevel: normalizeRiskLevel(call.riskLevel),
          startedAt: new Date().toISOString(),
        });
        this.deps.eventBus.emit(
          "agent.tool.started",
          {
            runId,
            toolCallId: call.id,
            skillId: call.skillId,
            name: call.name,
          },
          { runId },
        );

        // Apply backoff delay for retries
        if (attempt > 0) {
          const delay = RETRY_BACKOFF[attempt] ?? RETRY_BACKOFF[MAX_RETRIES];
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        // Execute via tool executor
        const result = await this.deps.toolExecutor.execute({
          runId,
          toolCallId: call.id,
          skillId: call.skillId,
          name: call.name,
          arguments: call.arguments,
          timeoutMs: call.timeoutMs,
          signal,
        });

        const summary: ToolCallSummary = {
          id: call.id,
          skillId: call.skillId,
          name: call.name,
          status: result.status,
          summary: result.summary,
        };

        // Emit appropriate event
        if (result.status === "completed") {
          await this.deps.toolCalls?.updateStatus(call.id, "completed", {
            result: {
              summary: result.summary,
              content: result.content,
              artifacts: result.artifacts,
              stdout: result.stdout,
              stderr: result.stderr,
            },
          });
          this.deps.eventBus.emit(
            "agent.tool.completed",
            {
              runId,
              toolCallId: call.id,
              skillId: call.skillId,
              summary: result.summary,
              artifacts: result.artifacts.map((a) => a.id),
            },
            { runId, conversationId },
          );
          for (const artifact of result.artifacts) {
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
          await this.deps.toolCalls?.updateStatus(call.id, result.status, {
            result: { summary: result.summary },
            error: result.error ?? {
              code: "AGENT_TOOL_EXECUTION_FAILED",
              message: result.summary,
            },
          });
          this.deps.eventBus.emit(
            "agent.tool.failed",
            {
              runId,
              toolCallId: call.id,
              skillId: call.skillId,
              error: result.error ?? {
                code: "AGENT_TOOL_EXECUTION_FAILED",
                message: result.summary,
              },
            },
            { runId },
          );
        }

        return { summary, artifacts: result.artifacts };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry if not retryable or signal is aborted
        if (!isRetryable(error) || signal.aborted) break;
      }
    }

    // All retries exhausted
    const errorMsg = lastError?.message ?? "Tool execution failed";
    await this.deps.toolCalls?.updateStatus(call.id, "failed", {
      error: {
        code: "AGENT_TOOL_EXECUTION_FAILED",
        message: errorMsg,
      },
    });
    this.deps.eventBus.emit(
      "agent.tool.failed",
      {
        runId,
        toolCallId: call.id,
        skillId: call.skillId,
        error: {
          code: "AGENT_TOOL_EXECUTION_FAILED",
          message: errorMsg,
        },
      },
      { runId },
    );

    return {
      summary: {
        id: call.id,
        skillId: call.skillId,
        name: call.name,
        status: "failed",
        summary: errorMsg,
      },
      artifacts: [],
    };
  }

  private groupByConcurrency(
    calls: Array<{
      id: string;
      skillId: string;
      name: string;
      arguments: Record<string, unknown>;
      riskLevel: string;
      timeoutMs: number;
    }>,
  ): Map<string, typeof calls> {
    const groups = new Map<string, typeof calls>();
    for (const call of calls) {
      const category = this.categoryFromSkillId(call.skillId);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(call);
    }
    return groups;
  }

  private categoryFromSkillId(skillId: string): string {
    if (skillId.startsWith("filesystem.read")) return "filesystem.read";
    if (skillId.startsWith("filesystem.write")) return "filesystem.write";
    if (skillId.startsWith("filesystem")) return "filesystem.read";
    if (skillId.startsWith("shell")) return "shell.execute";
    if (skillId.startsWith("network")) return "network.request";
    if (skillId.startsWith("artifact")) return "artifact.write";
    if (skillId.startsWith("database")) return "database.write";
    return "shell.execute"; // default conservative
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}

function normalizeRiskLevel(
  riskLevel: string,
): "low" | "medium" | "high" | "critical" {
  if (
    riskLevel === "low" ||
    riskLevel === "medium" ||
    riskLevel === "high" ||
    riskLevel === "critical"
  ) {
    return riskLevel;
  }
  return "low";
}
