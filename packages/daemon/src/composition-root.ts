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
 *   Execution:  toolExecutor（桥接 skill-runner + workflow executor）
 *   Reflection: BasicReflectionEngine
 *   Response:   ResponseComposer（LLM 流式输出 + 消息持久化）
 *   Memory:     DefaultMemoryWriter（显式/隐式记忆提取 + 脱敏 + 去重）
 *   Loop:       AgentLoopEngine（状态机，注入以上全部组件）
 *   Service:    AgentService（门面，注入 Loop + Abort + 幂等 + 审批裁决）
 *
 * 工具执行：
 * - workflow.* skillId → WorkflowToolExecutor（作为 Agent tool 在当前 run 内执行）
 * - 其他 skillId → SkillRunner.execute（走 skill-runner 包直接执行）
 */
import {
  type StepRecord,
} from "@sunpilot/protocol";
import {
  AbortRegistry,
  AgentLoopEngine,
  BasicReflectionEngine,
  ContextBuilder,
  DefaultMemoryWriter,
  ExecutionOrchestrator,
  SkillToolExecutor,
  ToolExecutorBridge,
  WorkflowToolExecutorAdapter,
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
  type AgentEventBus,
  type AgentLoopServiceConfig,
  ToolDecisionEngine,
  type Permission,
} from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";
import type { SkillRegistry } from "@sunpilot/skill-runner";
import { WorkflowToolExecutor, workflowToToolDescriptor } from "@sunpilot/workflow";

import type { LlmProvider } from "@sunpilot/core";

export function createAgentLoopService(deps: {
  database: DatabaseContext;
  skillRegistry: SkillRegistry;
  skillRunner?: import("@sunpilot/skill-runner").SkillRunner;
  llmProvider: LlmProvider;
  eventBus?: AgentEventBus;
  /** Persisted-event bus for external consumers.
   *  Created internally if not provided. */
  liveEventBus?: AgentEventBus;
  systemPrompt?: string;
}): AgentService {
  // ── Foundation ─────────────────────────────────────────────────
  const rawEventBus = deps.eventBus ?? new InMemoryAgentEventBus();
  const liveEventBus = deps.liveEventBus ?? new InMemoryAgentEventBus();
  const abortRegistry = new AbortRegistry();
  const runStateManager = new RepositoryRunStateManager(deps.database);
  const eventSink = new RepositoryAgentEventSink(deps.database);
  const agentRunInitializer = new RepositoryAgentRunInitializer(deps.database);

  // Wire: rawEventBus → persist → liveEventBus.
  // Internal components emit to rawEventBus; the persist subscriber bridges
  // persisted events to liveEventBus, which WebSocket broadcasters and
  // external stream hooks consume. This ensures all externally visible
  // events carry a real DB sequence (no sequence: -1 duplicates).
  rawEventBus.subscribe(async (event) => {
    if (event.sequence !== undefined) {
      // Already persisted (e.g. atomically created with DB sequence) —
      // forward directly to liveEventBus without re-persisting.
      liveEventBus.publish(event);
      return;
    }
    const persisted = await eventSink.persist(event);
    if (persisted) liveEventBus.publish(persisted);
  });

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
          .map((workflow) => {
            const descriptor = workflowToToolDescriptor(workflow);
            return {
              id: descriptor.id,
              name: descriptor.name,
              description: descriptor.description,
              category: descriptor.category,
            };
          }),
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
        ...workflows.map((workflow) => {
          const descriptor = workflowToToolDescriptor(workflow);
          return {
            ...descriptor,
            permissions: [] as Permission[],
          };
        }),
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
  // Workflow executor: delegates to @sunpilot/workflow WorkflowToolExecutor.
  const workflowToolExecutor = new WorkflowToolExecutor({
    findWorkflow: (id) => deps.database.workflows.findById(id),
    getRun: async (runId) =>
      (await deps.database.runs.findById(runId)) ?? undefined,
    createStep: async (step) => {
      await deps.database.steps.create({
        id: step.id,
        runId: step.runId,
        type: step.type as "skill" | "approval" | "builtin" | "manual",
        name: step.name,
        status: step.status as StepRecord["status"],
        skillId: step.skillId,
        input: step.input ?? {},
      });
    },
    updateStepStatus: (id, status, output, error) =>
      deps.database.steps.updateStatus(
        id,
        status as "completed" | "failed" | "cancelled" | "interrupted",
        output,
        error,
      ),
  });

  // Workflow executor adapter: bridges ToolExecutor interface
  // to WorkflowToolExecutor from @sunpilot/workflow.
  const workflowExecutor = new WorkflowToolExecutorAdapter(workflowToolExecutor);

  // Skill executor: delegates to SkillToolExecutor in core.
  const skillExecutor = new SkillToolExecutor({
    listSkills: () => deps.skillRegistry.list(),
    runSkill: async (step) => {
      if (!deps.skillRunner) {
        throw new Error(
          "SkillRunner is not configured for Agent tool execution.",
        );
      }
      return deps.skillRunner.execute(step);
    },
    createStep: async (step) => {
      await deps.database.steps.create({
        id: step.id,
        runId: step.runId,
        type: step.type as "skill" | "approval" | "builtin" | "manual",
        name: step.name,
        status: step.status as StepRecord["status"],
        skillId: step.skillId,
        input: step.input ?? {},
      });
    },
    updateStepStatus: (id, status, output, error) =>
      deps.database.steps.updateStatus(id, status, output, error),
    listArtifacts: async (runId) => deps.database.artifacts.list(runId),
  });

  const toolExecutor = new ToolExecutorBridge({
    skillExecutor,
    workflowExecutor,
  });

  const executionOrchestrator = new ExecutionOrchestrator({
    toolExecutor,
    eventBus: rawEventBus,
    toolCalls: deps.database.toolCalls,
  });

  // ── Reflection ─────────────────────────────────────────────────
  const reflectionEngine = new BasicReflectionEngine();

  // ── Response ───────────────────────────────────────────────────
  const responseComposer = new ResponseComposer({
    llm: deps.llmProvider,
    eventBus: rawEventBus,
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
    eventBus: rawEventBus,
    approvalRequestService,
    memoryWriter,
  });

  // ── Agent Service ──────────────────────────────────────────────
  const config: AgentLoopServiceConfig = {
    loopEngine,
    abortRegistry,
    eventBus: rawEventBus,
    liveEventBus,
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
