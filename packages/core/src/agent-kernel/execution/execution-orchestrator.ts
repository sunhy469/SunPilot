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
  MAX_REPAIR_ATTEMPTS,
  RETRY_BACKOFF,
  isRetryable,
  type ToolExecutor,
} from "./execution-types.js";
import type { ToolArgumentBuilder } from "../tools/tool-argument-builder.js";

export interface ExecutionOrchestratorDeps {
  /** Executor that actually runs tools (bridges to skill-runner). */
  toolExecutor: ToolExecutor;
  /** Event bus for emitting tool events. */
  eventBus: AgentEventBus;
  /** Durable audit log for tool invocations. */
  toolCalls?: ToolCallRepository;
  /** Optional schema-aware argument builder for repair loops. */
  argumentBuilder?: ToolArgumentBuilder;
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
      inputSchema?: Record<string, unknown>;
      argumentSources?: Array<{
        arg: string;
        source: string;
        ref?: string;
      }>;
    },
    signal: AbortSignal,
  ): Promise<{
    summary: ToolCallSummary;
    artifacts: ArtifactRef[];
  }> {
    // ── Emit tool_argument.generated event for provenance audit ──────
    if (call.argumentSources && call.argumentSources.length > 0) {
      this.deps.eventBus.emit(
        "agent.tool_argument.generated",
        {
          runId,
          toolCallId: call.id,
          skillId: call.skillId,
          sources: call.argumentSources,
        },
        { runId },
      );
    }

    // ── Validate arguments against schema before execution ───────────
    // Supports repair loop: on validation failure, feed errors back to
    // argument builder for regeneration, up to MAX_REPAIR_ATTEMPTS.
    // Tracks repair history for long-term audit.
    let currentArgs = call.arguments;
    let currentSchema = call.inputSchema;
    const originalArgs = { ...call.arguments };
    const repairHistory: Record<string, unknown>[] = [];

    if (currentSchema) {
      for (let repairAttempt = 0; repairAttempt <= MAX_REPAIR_ATTEMPTS; repairAttempt++) {
        const validationErrors = validateArguments(currentArgs, currentSchema);
        if (validationErrors.length === 0) break; // valid, proceed to execution

        // If we have an argument builder, attempt repair
        if (this.deps.argumentBuilder && repairAttempt < MAX_REPAIR_ATTEMPTS) {
          this.deps.eventBus.emit(
            "agent.tool_argument.validation_failed",
            {
              runId,
              toolCallId: call.id,
              skillId: call.skillId,
              name: call.name,
              validationErrors,
              failedArguments: { ...currentArgs },
              schema: currentSchema,
            },
            { runId },
          );

          try {
            const repairEntry: Record<string, unknown> = {
              attempt: repairAttempt,
              beforeArgs: { ...currentArgs },
              validationErrors: [...validationErrors],
            };
            const repaired = await this.deps.argumentBuilder.repair(
              {
                skillId: call.skillId,
                name: call.name,
                currentArgs,
                schema: currentSchema,
                validationErrors,
              },
              signal,
            );
            repairEntry.afterArgs = { ...repaired.arguments };
            repairEntry.repairSource = "heuristic";
            repairHistory.push(repairEntry);
            currentArgs = repaired.arguments;
            call.arguments = currentArgs;
            continue;
          } catch {
            // Repair failed — fall through to mark as failed
            repairHistory.push({
              attempt: repairAttempt,
              beforeArgs: { ...currentArgs },
              validationErrors: [...validationErrors],
            });
          }
        }

        // No repair possible or repair exhausted — mark as failed
        // ... (rest of the failure handling)
        this.deps.eventBus.emit(
          "agent.tool_argument.validation_failed",
          {
            runId,
            toolCallId: call.id,
            skillId: call.skillId,
            name: call.name,
            validationErrors,
            failedArguments: { ...currentArgs },
            schema: currentSchema,
          },
          { runId },
        );
        this.deps.eventBus.emit(
          "agent.tool.failed",
          {
            runId,
            toolCallId: call.id,
            skillId: call.skillId,
            name: call.name,
            error: {
              code: "ARGUMENT_VALIDATION_FAILED",
              message: `Argument validation failed: ${validationErrors.join("; ")}`,
            },
          },
          { runId },
        );
        await this.deps.toolCalls?.create({
          id: call.id,
          runId,
          skillId: call.skillId,
          name: call.name,
          arguments: currentArgs,
          status: "failed",
          riskLevel: normalizeRiskLevel(call.riskLevel),
          startedAt: new Date().toISOString(),
          metadata: {
            argumentSources: call.argumentSources ?? [],
            inputSchema: call.inputSchema ? true : false,
            validationErrors,
            repairHistory:
              repairHistory.length > 0 ? repairHistory : undefined,
            repairExhausted: repairHistory.length > 0,
          },
        });
        return {
          summary: {
            id: call.id,
            skillId: call.skillId,
            name: call.name,
            status: "failed",
            summary: `Argument validation failed: ${validationErrors.join("; ")}`,
          },
          artifacts: [],
        };
      }
    }

    // Create tool call record with audit metadata
    const now = new Date().toISOString();
    await this.deps.toolCalls?.create({
      id: call.id,
      runId,
      skillId: call.skillId,
      name: call.name,
      arguments: call.arguments,
      status: "running",
      riskLevel: normalizeRiskLevel(call.riskLevel),
      startedAt: now,
      metadata: {
        argumentSources: call.argumentSources ?? [],
        inputSchema: call.inputSchema ? true : false,
        repairHistory:
          repairHistory.length > 0
            ? repairHistory
            : undefined,
        wasRepaired:
          repairHistory.length > 0
            ? { originalArgs, repairedArgs: call.arguments }
            : undefined,
      },
    });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Emit tool.started event for each attempt
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
          structured: result.structured,
        };

        // Emit appropriate event
        if (result.status === "completed") {
          await this.deps.toolCalls?.updateStatus(call.id, "completed", {
            result: {
              summary: result.summary,
              content: result.content,
              structured: result.structured,
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
        structured: undefined,
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
    // Extract capability name for fully-qualified ids (<skill-id>:<capability>)
    const capability = skillId.includes(":")
      ? skillId.slice(skillId.lastIndexOf(":") + 1)
      : skillId;
    if (capability.startsWith("filesystem.read")) return "filesystem.read";
    if (capability.startsWith("filesystem.write")) return "filesystem.write";
    if (capability.startsWith("filesystem")) return "filesystem.read";
    if (capability.startsWith("shell")) return "shell.execute";
    if (capability.startsWith("network")) return "network.request";
    if (capability.startsWith("artifact")) return "artifact.write";
    if (capability.startsWith("database")) return "database.write";
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

/**
 * Validate tool arguments against a JSON Schema.
 * Returns a list of validation error messages, or an empty array if valid.
 *
 * Supports:
 * - required fields check
 * - type checks (string, number, array)
 * - enum constraints
 */
function validateArguments(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string[] {
  const errors: string[] = [];

  // Check required fields
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const field of required) {
      if (typeof field !== "string") continue;
      const value = args[field];
      if (value === undefined || value === null || value === "") {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  // Check property types if defined
  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    for (const [key, propSchema] of Object.entries(
      properties as Record<string, Record<string, unknown>>,
    )) {
      const value = args[key];
      if (value === undefined || value === null) continue;

      const propType = propSchema.type;
      if (propType === "string" && typeof value !== "string") {
        errors.push(`Field "${key}" must be a string`);
      }
      if (propType === "number" || propType === "integer") {
        if (typeof value !== "number") {
          errors.push(`Field "${key}" must be a number`);
        }
      }
      if (propType === "array" && !Array.isArray(value)) {
        errors.push(`Field "${key}" must be an array`);
      }

      // Check enum constraint
      const enumValues = propSchema.enum;
      if (Array.isArray(enumValues) && !enumValues.includes(value)) {
        errors.push(
          `Field "${key}" must be one of: ${enumValues.join(", ")}`,
        );
      }
    }
  }

  return errors;
}
