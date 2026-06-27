import type { LlmProvider } from "../../llm/llm.provider.js";
import type {
  ExecutionOrchestrator,
  PermissionPolicy,
  ToolDecisionEngine as ToolDecisionEngineInterface,
} from "../loop-types.js";
import type { AgentEventBus } from "../agent-event-bus.js";
import type { ModelRouter } from "../model-router.js";
import type { EmbeddingService } from "../context/embedding-service.js";
import type { ToolArgumentBuilder } from "./tool-argument-builder.js";
import type { ToolCallHistoryEntry, ToolRetriever } from "./tool-retriever.js";
import type { SkillSummary } from "./tool-types.js";
import { NativeToolLoopExecutor } from "./tool-decision-engine/native-tool-loop-executor.js";
import { ToolSelector } from "./tool-decision-engine/tool-selector.js";

export type {
  DecisionMetadata,
  LlmToolDecision,
  ToolLoopStopReason,
} from "./tool-decision-engine/types.js";
export { projectToolResultForModel } from "./tool-decision-engine/tool-result-projector.js";

export interface ToolDecisionEngineDeps {
  listSkills: () => Promise<SkillSummary[]>;
  llm?: LlmProvider;
  argumentBuilder?: ToolArgumentBuilder;
  toolRetriever?: ToolRetriever;
  embeddingService?: EmbeddingService;
  skillEmbeddingCache?: import("./skill-embedding-cache.js").SkillEmbeddingCache;
  recentHistory?: ToolCallHistoryEntry[];
  permissionMode?: "ask" | "auto" | "full";
  eventBus: AgentEventBus;
  modelRouter: ModelRouter;
  permissionPolicy: PermissionPolicy;
  executionOrchestrator: ExecutionOrchestrator;
  injectionDetector?: import("../safety/prompt-injection-detector.js").PromptInjectionDetector;
  saveMessage: (msg: {
    id: string;
    conversationId: string;
    role: "assistant";
    content: string;
    runId: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}

/**
 * Stable public facade for tool selection and native tool-loop execution.
 * The two responsibilities are implemented independently so they can evolve
 * and be tested without growing this integration boundary again.
 */
export class ToolDecisionEngine implements ToolDecisionEngineInterface {
  private readonly selector: ToolSelector;
  private readonly nativeToolLoop: NativeToolLoopExecutor;

  constructor(deps: ToolDecisionEngineDeps) {
    this.selector = new ToolSelector(deps);
    this.nativeToolLoop = new NativeToolLoopExecutor(deps);
  }

  decide(...args: Parameters<ToolSelector["decide"]>): ReturnType<ToolSelector["decide"]> {
    return this.selector.decide(...args);
  }

  executeStreaming(
    ...args: Parameters<NativeToolLoopExecutor["executeStreaming"]>
  ): ReturnType<NativeToolLoopExecutor["executeStreaming"]> {
    return this.nativeToolLoop.executeStreaming(...args);
  }
}
