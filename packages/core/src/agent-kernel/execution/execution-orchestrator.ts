import type { AgentEventBus } from "../agent-event-bus.js";
import type { ToolCallRepository } from "@sunpilot/storage";
import type {
  AgentContext,
  AgentObservation,
  ArtifactRef,
  ExecutionOrchestrator as ExecutionOrchestratorInterface,
  PlannedToolCall,
  ToolCallSummary,
} from "../loop-types.js";
import {
  DEFAULT_CONCURRENCY,
  MAX_RETRIES,
  RETRY_BACKOFF,
  isRetryable,
  type ToolExecutor,
} from "./execution-types.js";
import type {
  ApprovedToolScope,
  ToolSafetyBoundary,
} from "./tool-safety-boundary.js";
import {
  validateJsonSchemaValue,
  validateToolArguments,
} from "../tools/tool-argument-validator.js";

export interface ExecutionOrchestratorDeps {
  /** Executor that actually runs tools (bridges to skill-runner). */
  toolExecutor: ToolExecutor;
  /** Event bus for emitting tool events. */
  eventBus: AgentEventBus;
  /** Durable audit log for tool invocations. */
  toolCalls?: ToolCallRepository;
  /** Single pre/post tool security boundary. */
  safetyBoundary: ToolSafetyBoundary;
  /** Persisted execution gate checked immediately before each tool attempt. */
  canExecuteRun?: (runId: string) => Promise<boolean>;
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
      calls: PlannedToolCall[];
      permissionMode?: "ask" | "auto" | "full";
      approvedTools?: ApprovedToolScope[];
      /** Optional progress callback for content-block status updates (§P1-4). */
      onProgress?: (progress: import("../loop-types.js").ToolExecutionProgress) => void;
    },
    signal: AbortSignal,
  ): Promise<AgentObservation> {
    const { runId, context, calls: toolCalls, onProgress } = input;
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
          onProgress?.({
            phase: "running",
            message: `正在执行 ${call.name}`,
          });
          const result = await this.executeWithRetry(
            runId,
            context.conversationId,
            call,
            signal,
            input.permissionMode ?? "auto",
            input.approvedTools?.find((approval) => approval.toolCallId === call.id),
          );
          onProgress?.({
            phase: "completed",
            message: `完成: ${call.name}`,
            percent: 100,
          });
          results.push(result.summary);
          allArtifacts.push(...result.artifacts);
        }
      } else {
        // Parallel execution within concurrency limit
        const chunks = this.chunkArray(calls, maxConcurrent);
        for (const chunk of chunks) {
          if (signal.aborted) break;
          onProgress?.({
            phase: "running",
            message: `正在并行执行 ${chunk.length} 个工具`,
          });
          const chunkResults = await Promise.all(
            chunk.map((call) =>
              signal.aborted
                ? Promise.resolve(null)
                : this.executeWithRetry(
                    runId,
                    context.conversationId,
                    call,
                    signal,
                    input.permissionMode ?? "auto",
                    input.approvedTools?.find((approval) => approval.toolCallId === call.id),
                  ),
            ),
          );
          onProgress?.({
            phase: "completed",
            message: `完成 ${chunkResults.filter(Boolean).length} 个工具`,
            percent: 100,
          });
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
    call: PlannedToolCall,
    signal: AbortSignal,
    permissionMode: "ask" | "auto" | "full",
    approval?: ApprovedToolScope,
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

    // Guard validation is repeated defensively at the execution boundary,
    // but execution never invokes a second semantic repair model. Invalid
    // calls return a failed observation to the next ReAct turn.
    let currentArgs = call.arguments;
    const currentSchema = call.inputSchema;
    if (currentSchema) {
      const validationErrors = validateToolArguments(currentArgs, currentSchema);
      if (validationErrors.length > 0) {
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
            repairHistory: undefined,
            repairExhausted: false,
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

    const safety = this.deps.safetyBoundary.checkBeforeExecution({
      runId,
      conversationId,
      call,
      arguments: currentArgs,
      permissionMode,
      approval,
    });
    if (!safety.allowed) {
      const denial = safety.denial!;
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
          safetyDenied: true,
          safetyCode: denial.code,
          argumentSources: call.argumentSources ?? [],
        },
      });
      await this.deps.toolCalls?.updateStatus(call.id, "failed", {
        error: { code: denial.code, message: denial.reason },
      });
      this.deps.eventBus.emit(
        "agent.tool.failed",
        {
          runId,
          toolCallId: call.id,
          skillId: call.skillId,
          name: call.name,
          error: { code: denial.code, message: denial.reason },
        },
        { runId, conversationId },
      );
      return {
        summary: {
          id: call.id,
          skillId: call.skillId,
          name: call.name,
          status: "failed",
          summary: denial.reason,
          metadata: { safetyDenied: true, safetyCode: denial.code },
        },
        artifacts: [],
      };
    }
    currentArgs = safety.arguments;

    // Do not create a running audit record unless this run still owns
    // execution. This closes the cancel window between the safety check and
    // durable tool-call creation.
    if (!(await this.isRunExecutable(runId, signal))) {
      return this.cancelledToolResult(call);
    }

    // Create tool call record with audit metadata
    const now = new Date().toISOString();
    await this.deps.toolCalls?.create({
      id: call.id,
      runId,
      skillId: call.skillId,
      name: call.name,
      // §B15: use the locally-tracked currentArgs (may differ from the
      // original call.arguments if repair succeeded) instead of mutating
      // the input call object.
      arguments: currentArgs,
      status: "running",
      riskLevel: normalizeRiskLevel(call.riskLevel),
      startedAt: now,
      metadata: {
        ...(call.metadata ?? {}),
        argumentSources: call.argumentSources ?? [],
        inputSchema: call.inputSchema ? true : false,
      },
    });

    let lastError: Error | undefined;

    // §P1-04: Determine per-call retry policy based on idempotency and
    // side-effects. Non-idempotent mutation/network/destructive tools default
    // to 0 retries (1 total attempt) unless their timeoutPolicy explicitly
    // allows more. Idempotent/readonly tools keep the original MAX_RETRIES.
    const isReadonlyLike =
      call.idempotent ||
      call.sideEffects === "none" ||
      call.sideEffects === "readonly";
    const maxAttempts = !isReadonlyLike
      ? 1
      : call.timeoutPolicy
        ? call.timeoutPolicy.retryable
          ? 1 + call.timeoutPolicy.maxRetries
          : 1
        : MAX_RETRIES;

    // §B15: `<=` would execute MAX_RETRIES+1 total attempts (off-by-one);
    // use `<` so the loop runs exactly maxAttempts times.
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Apply backoff delay for retries
        if (attempt > 0) {
          const delay = call.timeoutPolicy
            ? call.timeoutPolicy.backoffMs
            : RETRY_BACKOFF[attempt] ?? RETRY_BACKOFF[MAX_RETRIES] ?? 0;
          await abortableDelay(delay, signal);
        }

        // Re-check both process-local cancellation and persisted run state
        // after backoff, immediately before every irreversible attempt.
        if (!(await this.isRunExecutable(runId, signal))) {
          await this.deps.toolCalls?.updateStatus(call.id, "cancelled", {
            error: {
              code: "AGENT_RUN_NOT_EXECUTABLE",
              message: "Run lost execution ownership before tool execution",
            },
          });
          return this.cancelledToolResult(call);
        }

        // Emit tool.started only after the final execution gate succeeds.
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

        // Execute via tool executor
        let rawResult = await this.deps.toolExecutor.execute({
          runId,
          toolCallId: call.id,
          skillId: call.skillId,
          name: call.name,
          arguments: currentArgs,
          timeoutMs: call.timeoutMs,
          signal,
        });
        if (rawResult.status === "completed" && call.outputSchema) {
          const outputErrors = validateJsonSchemaValue(
            rawResult.rawOutput,
            call.outputSchema,
          );
          if (outputErrors.length > 0) {
            const message = `Tool output validation failed: ${outputErrors.join("; ")}`;
            this.deps.eventBus.emit(
              "agent.tool_output.validation_failed",
              {
                runId,
                toolCallId: call.id,
                skillId: call.skillId,
                name: call.name,
                validationErrors: outputErrors,
              },
              { runId, conversationId },
            );
            rawResult = {
              ...rawResult,
              status: "failed",
              summary: message,
              error: {
                code: "TOOL_OUTPUT_VALIDATION_FAILED",
                message,
              },
            };
          }
        }
        const safetyResult = this.deps.safetyBoundary.checkAfterExecution({
          runId,
          conversationId,
          call: { ...call, arguments: currentArgs },
          result: rawResult,
        });
        const result = safetyResult.result;

        const summary: ToolCallSummary = {
          id: call.id,
          skillId: call.skillId,
          name: call.name,
          status: result.status,
          summary: result.summary,
          // §P0-2: Propagate full content and structured data so the model
          // sees the actual tool output, not just the terse summary.
          content: result.content,
          structured: result.structured,
          metadata: {
            ...(call.metadata ?? {}),
            projectionHints: call.projectionHints,
            safety: safetyResult.metadata,
          },
          artifactIds: result.artifacts.map((artifact) => artifact.id),
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
              safety: safetyResult.metadata,
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
            result: {
              summary: result.summary,
              content: result.content,
              safety: safetyResult.metadata,
            },
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

  private async isRunExecutable(
    runId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    return this.deps.canExecuteRun
      ? this.deps.canExecuteRun(runId)
      : true;
  }

  private cancelledToolResult(call: PlannedToolCall): {
    summary: ToolCallSummary;
    artifacts: ArtifactRef[];
  } {
    return {
      summary: {
        id: call.id,
        skillId: call.skillId,
        name: call.name,
        status: "cancelled",
        summary: "Run was cancelled before tool execution",
      },
      artifacts: [],
    };
  }

  private groupByConcurrency(
    calls: PlannedToolCall[],
  ): Map<string, typeof calls> {
    const groups = new Map<string, typeof calls>();
    for (const call of calls) {
      const category = this.categoryFromSkillId(call.skillId);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(call);
    }
    return groups;
  }

  clearSafetyState(runId: string): void {
    this.deps.safetyBoundary.clearRun(runId);
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

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error("Tool retry aborted"), {
      name: "AbortError",
    }));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Tool retry aborted"), { name: "AbortError" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
