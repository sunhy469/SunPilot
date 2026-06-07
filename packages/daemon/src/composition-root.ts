/**
 * Composition Root — 组装 Agent Loop 全部依赖的唯一入口。
 *
 * 这里是全部具体实现被"接线"的唯一位置。daemon server.ts 只需调用
 * createAgentLoopService 即可获得完全配置好的 AgentService。
 *
 * 装配层次：
 *   Foundation: EventBus → AbortRegistry → RunStateManager → EventSink → RunInitializer
 *   Context:    ContextBuilder（多数据源适配器）
 *   Intent:     IntentRouter（规则 + LLM 双路径）
 *   Tools:      ToolDecisionEngine（技能发现 + 意图匹配）
 *   Safety:     PermissionPolicy → ApprovalGate → ApprovalDecisionService
 *   Planner:    RuleBasedPlanner
 *   Execution:  toolExecutor（桥接 skill-runner + workflow runtime）
 *   Reflection: BasicReflectionEngine
 *   Response:   ResponseComposer（LLM 流式输出 + 消息持久化）
 *   Memory:     DefaultMemoryWriter（显式/隐式记忆提取 + 脱敏 + 去重）
 *   Loop:       AgentLoopEngine（状态机，注入以上全部组件）
 *   Service:    AgentService（门面，注入 Loop + Abort + 幂等 + 审批裁决）
 *
 * 工具执行分两条路径：
 * - workflow.* skillId → SunPilotRuntime.createRun（走旧 Runtime 审批流程）
 * - 其他 skillId → SkillRunner.execute（走 skill-runner 包直接执行）
 */
import {
  type ArtifactRecord,
  type InstalledSkillRecord,
  type StepRecord,
  type SkillRisk,
} from "@sunpilot/protocol";
import {
  AbortRegistry,
  AgentLoopEngine,
  BasicReflectionEngine,
  ContextBuilder,
  DefaultMemoryWriter,
  ExecutionOrchestrator,
  InMemoryAgentEventBus,
  IntentRouter,
  PermissionPolicy,
  ResponseComposer,
  RuleBasedPlanner,
  RepositoryAgentEventSink,
  RepositoryAgentRunInitializer,
  RepositoryApprovalDecisionService,
  RepositoryApprovalGate,
  RepositoryApprovalRequestService,
  RepositoryRunStateManager,
  AgentService,
  type AgentLoopServiceConfig,
  ToolDecisionEngine,
  type Permission,
} from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";
import type { SkillRegistry } from "@sunpilot/skill-runner";

import type { LlmProvider } from "@sunpilot/core";

export function createAgentLoopService(deps: {
  database: DatabaseContext;
  skillRegistry: SkillRegistry;
  skillRunner?: import("@sunpilot/skill-runner").SkillRunner;
  workflowRuntime?: import("@sunpilot/core").SunPilotRuntime;
  llmProvider: LlmProvider;
  systemPrompt?: string;
}): AgentService {
  // ── Foundation ─────────────────────────────────────────────────
  const eventBus = new InMemoryAgentEventBus();
  const abortRegistry = new AbortRegistry();
  const runStateManager = new RepositoryRunStateManager(deps.database);
  const eventSink = new RepositoryAgentEventSink(deps.database);
  const agentRunInitializer = new RepositoryAgentRunInitializer(deps.database);
  eventBus.subscribe((event) => eventSink.persist(event));

  // ── Context ────────────────────────────────────────────────────
  const contextBuilder = new ContextBuilder({
    listMessages: async (conversationId, limit) => {
      const messages =
        await deps.database.messages.listByConversationId(conversationId);
      return messages.slice(0, limit ?? 30).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      }));
    },
    searchMemories: async (input) => {
      try {
        const memories = await deps.database.memory.search({
          query: input.query,
          runId: input.runId,
          conversationId: input.conversationId,
          userId: input.userId,
          limit: input.limit ?? 10,
        });
        return memories.map((memory) => ({
          id: memory.id,
          type: memory.type ?? "manual_note",
          title: memory.title ?? memory.key,
          content:
            memory.content ??
            (typeof memory.value === "string"
              ? memory.value
              : JSON.stringify(memory.value)),
          source: memory.source ?? "memory",
          confidence: memory.confidence ?? 0.8,
          scope: memory.scope,
          scopeId: memory.scopeId,
          score: memory.score,
        }));
      } catch {
        return [];
      }
    },
    listSkills: async () => {
      const skills = deps.skillRegistry.list();
      const skillCapabilities = skills.flatMap((s) =>
        s.manifest.capabilities.map((capability) => ({
          id: capability.name,
          name: capability.title,
          description: capability.description,
          category: categoryFromCapability(capability.name),
        })),
      );
      const workflows = await deps.database.workflows.list();
      return [
        ...skillCapabilities,
        ...workflows
          .filter((workflow) => workflow.enabled)
          .map((workflow) => ({
            id: `workflow.${workflow.id}`,
            name: workflow.title,
            description: workflowDescription(workflow.definition),
            category: "workflow" as const,
          })),
      ];
    },
    listArtifacts: async (runId) => {
      const artifacts = await deps.database.artifacts.list(runId);
      return artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        type: artifact.type,
        summary:
          typeof artifact.metadata.content_summary === "string"
            ? artifact.metadata.content_summary
            : undefined,
      }));
    },
    listToolResults: async (runId) => {
      const toolCalls = await deps.database.toolCalls.listByRunId(runId);
      return toolCalls.map((toolCall) => ({
        toolCallId: toolCall.id,
        name: toolCall.name,
        skillId: toolCall.skillId,
        status: toolCall.status,
        summary: toolResultSummary(toolCall.result),
        content: toolResultContent(toolCall.result),
      }));
    },
    systemPrompt: {
      persona:
        deps.systemPrompt ??
        "You are SunPilot, a concise and capable local agent assistant.",
      rules: [
        "Always respond in the same language as the user.",
        "Use tools when they help complete the task more effectively.",
        "Cite memory sources when using remembered information.",
      ],
    },
  });

  // ── Intent ─────────────────────────────────────────────────────
  const intentRouter = new IntentRouter({
    llm: deps.llmProvider,
  });

  // ── Tools ──────────────────────────────────────────────────────
  const toolDecisionEngine = new ToolDecisionEngine({
    listSkills: async () => {
      const skills = deps.skillRegistry.list();
      const skillCapabilities = skills.flatMap((s) =>
        s.manifest.capabilities.map((capability) => ({
          id: capability.name,
          name: capability.title,
          description: capability.description,
          category: categoryFromCapability(capability.name),
          enabled: s.enabled,
          permissions: normalizeCapabilityPermissions(capability.permissions),
          defaultTimeoutMs: 60_000,
          maxTimeoutMs: 300_000,
          supportsAbort: true,
          idempotent: false,
          riskHints: {
            defaultRisk: capability.risk as
              | "low"
              | "medium"
              | "high"
              | "critical",
          },
        })),
      );
      const workflows = await deps.database.workflows.list();
      return [
        ...skillCapabilities,
        ...workflows.map((workflow) => ({
          id: `workflow.${workflow.id}`,
          name: workflow.title,
          description: workflowDescription(workflow.definition),
          category: "workflow" as const,
          enabled: workflow.enabled,
          permissions: [],
          defaultTimeoutMs: 60_000,
          maxTimeoutMs: 300_000,
          supportsAbort: false,
          idempotent: false,
          riskHints: { defaultRisk: "medium" as const },
        })),
      ];
    },
  });

  // ── Safety ─────────────────────────────────────────────────────
  const permissionPolicy = new PermissionPolicy();
  const approvalGate = new RepositoryApprovalGate(deps.database);
  const approvalDecisionService = new RepositoryApprovalDecisionService(
    deps.database,
  );
  const approvalRequestService = new RepositoryApprovalRequestService(
    deps.database,
  );

  // ── Planner ────────────────────────────────────────────────────
  const planner = new RuleBasedPlanner();

  // ── Execution ──────────────────────────────────────────────────
  const toolExecutor = {
    async execute(params: {
      runId: string;
      toolCallId: string;
      skillId: string;
      name: string;
      arguments: Record<string, unknown>;
      timeoutMs: number;
      signal: AbortSignal;
    }) {
      if (params.skillId.startsWith("workflow.")) {
        if (!deps.workflowRuntime) {
          return {
            status: "failed" as const,
            summary: "Workflow runtime is not configured for Agent execution.",
            artifacts: [],
            error: {
              code: "AGENT_WORKFLOW_EXECUTION_FAILED",
              message:
                "Workflow runtime is not configured for Agent execution.",
            },
          };
        }
        const workflowId = params.skillId.slice("workflow.".length);
        try {
          const workflowRun = await deps.workflowRuntime.createRun(
            {
              ...params.arguments,
              parentAgentRunId: params.runId,
              toolCallId: params.toolCallId,
            },
            workflowId,
            "approval_required",
          );
          return {
            status: "completed" as const,
            summary: `Workflow ${workflowId} started as ${workflowRun.id} with status ${workflowRun.status}.`,
            content: JSON.stringify({
              workflowRunId: workflowRun.id,
              status: workflowRun.status,
            }),
            artifacts: [],
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            status: "failed" as const,
            summary: message,
            artifacts: [],
            error: {
              code: "AGENT_WORKFLOW_EXECUTION_FAILED",
              message,
            },
          };
        }
      }

      if (!deps.skillRunner) {
        return {
          status: "failed" as const,
          summary: "SkillRunner is not configured for Agent tool execution.",
          artifacts: [],
          error: {
            code: "AGENT_TOOL_EXECUTION_FAILED",
            message: "SkillRunner is not configured for Agent tool execution.",
          },
        };
      }

      const target = resolveCapability(
        deps.skillRegistry.list(),
        params.skillId,
      );
      if (!target) {
        return {
          status: "failed" as const,
          summary: `No enabled skill capability found for ${params.skillId}.`,
          artifacts: [],
          error: {
            code: "AGENT_TOOL_NOT_FOUND",
            message: `No enabled skill capability found for ${params.skillId}.`,
          },
        };
      }

      const beforeArtifacts = new Set(
        (await deps.database.artifacts.list(params.runId)).map(
          (artifact) => artifact.id,
        ),
      );
      const step: StepRecord = {
        id: params.toolCallId,
        runId: params.runId,
        type: "skill",
        name: target.capability.title,
        status: "running",
        skillId: target.skill.id,
        capability: target.capability.name,
        input: params.arguments,
      };
      await deps.database.steps.create(step);

      try {
        const output = await deps.skillRunner.execute(step);
        await deps.database.steps.updateStatus(step.id, "completed", output);
        const artifacts = (await deps.database.artifacts.list(params.runId))
          .filter((artifact) => !beforeArtifacts.has(artifact.id))
          .map(toArtifactRef);
        return {
          status: "completed" as const,
          summary: summarizeToolOutput(output),
          content: typeof output === "string" ? output : undefined,
          artifacts,
        };
      } catch (error) {
        const status: "cancelled" | "failed" = params.signal.aborted
          ? "cancelled"
          : "failed";
        const message = error instanceof Error ? error.message : String(error);
        await deps.database.steps.updateStatus(step.id, status, undefined, {
          code:
            status === "cancelled"
              ? "AGENT_RUN_CANCELLED"
              : "AGENT_TOOL_EXECUTION_FAILED",
          message,
        });
        return {
          status,
          summary: message,
          artifacts: [],
          error: {
            code:
              status === "cancelled"
                ? "AGENT_RUN_CANCELLED"
                : "AGENT_TOOL_EXECUTION_FAILED",
            message,
          },
        };
      }
    },
  };

  const executionOrchestrator = new ExecutionOrchestrator({
    toolExecutor,
    eventBus,
    toolCalls: deps.database.toolCalls,
  });

  // ── Reflection ─────────────────────────────────────────────────
  const reflectionEngine = new BasicReflectionEngine();

  // ── Response ───────────────────────────────────────────────────
  const responseComposer = new ResponseComposer({
    llm: deps.llmProvider,
    eventBus,
    modelCalls: deps.database.modelCalls,
    saveMessage: async (input) => {
      try {
        await deps.database.messages.create({
          id: input.id,
          conversationId: input.conversationId,
          role: input.role as "system" | "user" | "assistant",
          content: input.content,
        });
      } catch {
        // Best effort
      }
    },
  });

  // ── Memory ────────────────────────────────────────────────────
  const memoryWriter = new DefaultMemoryWriter({
    repository: deps.database.memory,
  });

  // ── Loop Engine ────────────────────────────────────────────────
  const loopEngine = new AgentLoopEngine({
    contextBuilder,
    intentRouter,
    planner,
    toolDecisionEngine,
    executionOrchestrator,
    permissionPolicy,
    approvalGate,
    reflectionEngine,
    responseComposer,
    runStateManager,
    eventBus,
    approvalRequestService,
    memoryWriter,
  });

  // ── Agent Service ──────────────────────────────────────────────
  const config: AgentLoopServiceConfig = {
    loopEngine,
    abortRegistry,
    eventBus,
    runStateManager,
    approvalGate,
    approvalDecisionService,
    agentRunInitializer,
    idempotency: deps.database.idempotency,
    database: deps.database,
    conversations: {
      createConversation: async (input) => {
        const conv = await deps.database.conversations.create({
          id: input?.id,
          title: input?.title,
        });
        return {
          id: conv.id,
          title: conv.title,
          status: "active" as const,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        };
      },
      findConversationById: async (id) => {
        const conv = await deps.database.conversations.findById(id);
        if (!conv) return null;
        return {
          id: conv.id,
          title: conv.title,
          status: "active" as const,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        };
      },
      createMessage: async (input) => {
        const msg = await deps.database.messages.create({
          id: input.id,
          conversationId: input.conversationId,
          role: input.role as "system" | "user" | "assistant",
          content: input.content,
        });
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt,
        };
      },
      listMessages: async (conversationId) => {
        const msgs =
          await deps.database.messages.listByConversationId(conversationId);
        return msgs.map((m) => ({
          id: m.id,
          conversationId: m.conversationId,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        }));
      },
    },
  };

  return new AgentService(config);
}

function resolveCapability(
  skills: InstalledSkillRecord[],
  requested: string,
):
  | {
      skill: InstalledSkillRecord;
      capability: InstalledSkillRecord["manifest"]["capabilities"][number];
    }
  | undefined {
  const [skillId, capabilityName] = requested.includes(":")
    ? requested.split(":", 2)
    : [undefined, requested];

  for (const skill of skills) {
    if (!skill.enabled) continue;
    if (skillId && skill.id !== skillId) continue;
    const capability = skill.manifest.capabilities.find(
      (item) => item.name === capabilityName,
    );
    if (capability) return { skill, capability };
  }
  return undefined;
}

function categoryFromCapability(
  capability: string,
):
  | "filesystem"
  | "shell"
  | "code"
  | "web"
  | "memory"
  | "artifact"
  | "workflow"
  | "custom" {
  if (capability.startsWith("filesystem")) return "filesystem";
  if (capability.startsWith("shell")) return "shell";
  if (capability.startsWith("web") || capability.startsWith("network"))
    return "web";
  if (capability.startsWith("memory")) return "memory";
  if (capability.startsWith("artifact")) return "artifact";
  if (capability.startsWith("workflow")) return "workflow";
  if (capability.startsWith("code")) return "code";
  return "custom";
}

function summarizeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined) return "Tool completed.";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function workflowDescription(definition: unknown): string {
  if (definition && typeof definition === "object") {
    const description = (definition as { description?: unknown }).description;
    if (typeof description === "string" && description.trim()) {
      return description;
    }
  }
  return "Run a structured workflow.";
}

function normalizeCapabilityPermissions(permissions: string[]): Permission[] {
  const normalized = permissions.flatMap((permission) => {
    switch (permission) {
      case "filesystem":
        return ["filesystem.read", "filesystem.write"] as Permission[];
      case "filesystem.read":
      case "filesystem.write":
      case "filesystem.delete":
      case "shell.execute":
      case "network.request":
      case "database.read":
      case "database.write":
      case "secret.read":
      case "artifact.write":
      case "memory.write":
      case "external.send":
        return [permission] as Permission[];
      case "shell":
        return ["shell.execute"] as Permission[];
      case "network":
      case "web":
        return ["network.request"] as Permission[];
      case "database":
      case "db":
        return ["database.read", "database.write"] as Permission[];
      case "env":
      case "secret":
        return ["secret.read"] as Permission[];
      case "artifact":
        return ["artifact.write"] as Permission[];
      case "memory":
        return ["memory.write"] as Permission[];
      default:
        return [];
    }
  });
  return [...new Set(normalized)];
}

function toArtifactRef(artifact: ArtifactRecord): {
  id: string;
  name: string;
  type: string;
  version?: number;
} {
  return {
    id: artifact.id,
    name: artifact.name,
    type: artifact.type,
    version: artifact.version,
  };
}

function toolResultSummary(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const summary = (result as { summary?: unknown }).summary;
  return typeof summary === "string" ? summary : undefined;
}

function toolResultContent(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}
