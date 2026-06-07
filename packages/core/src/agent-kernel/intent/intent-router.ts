import type { LlmProvider } from "../../llm/llm.provider.js";
import type {
  AgentContext,
  IntentRouter as IntentRouterInterface,
  RoutedIntent,
} from "../loop-types.js";
import { DEFAULT_INTENT_RULES, type IntentRule } from "./intent-types.js";

export interface IntentRouterDeps {
  /**
   * Optional light model for intent classification.
   * If not provided, falls back to rule-based matching only.
   */
  llm?: LlmProvider;
  /** Custom intent rules to prepend before defaults. */
  rules?: IntentRule[];
}

/**
 * IntentRouter — 用户意图分类器，采用三级优先级级联策略：
 *
 * 1. 规则匹配（最快，无 LLM 调用）
 *    - 预定义正则模式匹配常见意图（问候、文件操作、Shell 命令等）
 *    - 命中后直接返回 RoutedIntent，附带候选技能列表和风险等级
 *
 * 2. LLM 轻量分类（规则未命中时降级使用）
 *    - 调用轻量模型做意图分类，避免对简单问候调用大模型
 *    - 仅在规则全部未命中时触发
 *
 * 3. 默认 unknown（兜底）
 *    - 置信度 0.3，不推荐使用工具，走纯 LLM 回答路径
 *
 * 架构文档 §10.3
 */
export class IntentRouter implements IntentRouterInterface {
  private readonly rules: IntentRule[];

  constructor(private readonly deps: IntentRouterDeps = {}) {
    this.rules = [...(deps.rules ?? []), ...DEFAULT_INTENT_RULES];
  }

  async route(
    context: AgentContext,
    _signal: AbortSignal,
  ): Promise<RoutedIntent> {
    const message = context.currentMessage.content;

    // ── Step 1: Rule-based matching ───────────────────────────────
    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        if (pattern.test(message)) {
          return {
            type: rule.type,
            confidence: 0.85,
            requiresPlanning: rule.requiresPlanning,
            requiresTool: rule.requiresTool,
            requiresApproval: rule.requiresApproval,
            riskLevel: rule.riskLevel,
            candidateSkills: rule.candidateSkills,
            reason: `Matched rule pattern: ${pattern.source}`,
          };
        }
      }
    }

    // ── Step 2: LLM classification (if available) ─────────────────
    if (this.deps.llm) {
      try {
        const intent = await this.classifyWithLlm(message);
        if (intent) return intent;
      } catch {
        // LLM unavailable — fall through to default
      }
    }

    // ── Step 3: Default 'unknown' intent ──────────────────────────
    return {
      type: "unknown",
      confidence: 0.3,
      requiresPlanning: false,
      requiresTool: false,
      requiresApproval: false,
      riskLevel: "low",
      candidateSkills: [],
      reason: "No rule or model match — defaulting to unknown",
    };
  }

  /**
   * Use a lightweight LLM call to classify intent.
   * Only called when rule-based matching fails.
   */
  private async classifyWithLlm(message: string): Promise<RoutedIntent | null> {
    if (!this.deps.llm) return null;

    const prompt = `Classify the user's intent into EXACTLY ONE of these categories:
- casual_chat: greetings, small talk, thanks
- question_answering: asking for information or explanation
- project_analysis: reviewing or analyzing code/project structure
- code_generation: writing new code, functions, or components
- code_modification: fixing, refactoring, or editing existing code
- file_operation: reading, writing, or managing files
- shell_operation: running commands, builds, or tests
- workflow_execution: running a multi-step workflow
- artifact_generation: generating documents or reports
- memory_update: saving or updating preferences/facts
- diagnostics: debugging or troubleshooting

User message: "${message}"

Respond with ONLY the category name, nothing else.`;

    const messages = [{ role: "user" as const, content: prompt }];
    let response = "";

    for await (const chunk of this.deps.llm.streamChat({ messages })) {
      response += chunk.delta;
    }

    const normalized = response.trim().toLowerCase();
    const validTypes = [
      "casual_chat",
      "question_answering",
      "project_analysis",
      "code_generation",
      "code_modification",
      "file_operation",
      "shell_operation",
      "workflow_execution",
      "artifact_generation",
      "memory_update",
      "diagnostics",
    ];

    if (validTypes.includes(normalized)) {
      return this.defaultsForType(normalized as RoutedIntent["type"]);
    }

    return null;
  }

  private defaultsForType(type: RoutedIntent["type"]): RoutedIntent {
    switch (type) {
      case "casual_chat":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: false,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [],
          reason: "LLM classified as casual chat",
        };
      case "question_answering":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: false,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [],
          reason: "LLM classified as question answering",
        };
      case "code_generation":
      case "code_modification":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: true,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: ["filesystem.read", "filesystem.write"],
          reason: `LLM classified as ${type}`,
        };
      case "file_operation":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: ["filesystem.read", "filesystem.write"],
          reason: "LLM classified as file operation",
        };
      case "shell_operation":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: true,
          riskLevel: "high",
          candidateSkills: ["shell.execute"],
          reason: "LLM classified as shell operation",
        };
      case "workflow_execution":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: ["workflow"],
          reason: "LLM classified as workflow execution",
        };
      default:
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: false,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [],
          reason: `LLM classified as ${type}`,
        };
    }
  }
}
