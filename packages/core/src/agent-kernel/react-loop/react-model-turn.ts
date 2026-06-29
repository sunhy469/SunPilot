import type {
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from "../../llm/llm.types.js";
import type { AgentEventBus } from "../agent-event-bus.js";
import { DeltaThrottle } from "../agent-event-bus.js";
import type { IAssistantMessageStream } from "../loop-types.js";
import type { ModelRouter } from "../model-router.js";
import { parseTextualFunctionCalls } from "../tools/textual-function-call-parser.js";
import type { ReactModelTurnResult } from "./react-types.js";

interface ToolCallAccumulator {
  index: number;
  id: string;
  type: "function";
  functionName: string;
  functionArguments: string;
}

export interface ReactModelTurnDeps {
  modelRouter: ModelRouter;
  eventBus: AgentEventBus;
}

/** Executes exactly one native function-calling model turn. */
export class ReactModelTurn {
  constructor(private readonly deps: ReactModelTurnDeps) {}

  async run(input: {
    runId: string;
    conversationId: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    modelId?: "dp" | "seed";
    stream?: IAssistantMessageStream;
    textRole: "progress" | "final";
    disableTools?: boolean;
  }, signal: AbortSignal): Promise<ReactModelTurnResult> {
    const modelCallId = `model_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    let firstTokenMs = 0;
    let text = "";
    let textPartId: string | undefined;
    const accumulators = new Map<number, ToolCallAccumulator>();
    let bufferingTextualCall = false;
    let textualCallBuffer = "";

    this.deps.eventBus.emit(
      "agent.model.started",
      {
        runId: input.runId,
        modelCallId,
        provider: "llm.openai-compatible",
        model: input.modelId ?? "default",
      },
      { runId: input.runId, conversationId: input.conversationId },
    );

    const deltaThrottle = new DeltaThrottle((delta) => {
      this.deps.eventBus.emit(
        "agent.model.delta",
        { runId: input.runId, modelCallId, delta },
        { runId: input.runId, conversationId: input.conversationId },
      );
    }, 50);

    try {
      for await (const chunk of this.deps.modelRouter.streamChat(
        "response_composition",
        {
          messages: input.messages,
          tools:
            !input.disableTools && input.tools.length > 0
              ? input.tools
              : undefined,
          tool_choice:
            !input.disableTools && input.tools.length > 0 ? "auto" : "none",
          runId: input.runId,
          modelCallId,
          modelId: input.modelId,
          metadata: { reactTurn: true, toolsDisabled: !!input.disableTools },
        },
        signal,
      )) {
        if (chunk.delta.length > 0) {
          if (firstTokenMs === 0) firstTokenMs = Date.now() - startedAt;

          if (
            chunk.delta.includes("<FunctionCallBegin>") ||
            bufferingTextualCall
          ) {
            bufferingTextualCall = true;
            textualCallBuffer += chunk.delta;
            if (chunk.delta.includes("<FunctionCallEnd>")) {
              bufferingTextualCall = false;
            }
          } else {
            if (input.stream && !textPartId) {
              textPartId = input.stream.startTextPart(input.textRole).id;
            }
            text += chunk.delta;
            input.stream?.appendText(textPartId!, chunk.delta);
            deltaThrottle.push(chunk.delta);
          }
        }

        for (const delta of chunk.toolCalls ?? []) {
          if (firstTokenMs === 0) firstTokenMs = Date.now() - startedAt;
          let accumulator = accumulators.get(delta.index);
          if (!accumulator) {
            accumulator = {
              index: delta.index,
              id: "",
              type: "function",
              functionName: "",
              functionArguments: "",
            };
            accumulators.set(delta.index, accumulator);
          }
          if (delta.id) accumulator.id = delta.id;
          if (delta.function?.name) {
            accumulator.functionName = delta.function.name;
          }
          if (delta.function?.arguments) {
            accumulator.functionArguments += delta.function.arguments;
          }
        }
      }

      deltaThrottle.flush();
      const nativeCalls = buildToolCalls(accumulators);
      const textualCalls = input.disableTools
        ? []
        : parseTextualFunctionCalls(textualCallBuffer, input.tools);
      const toolCalls = nativeCalls.length > 0 ? nativeCalls : textualCalls;
      const protocolError =
        accumulators.size > nativeCalls.length
          ? "incomplete native tool-call delta"
          : textualCallBuffer && textualCalls.length === 0
            ? "malformed textual function call"
            : undefined;

      this.deps.eventBus.emit(
        "agent.model.completed",
        {
          runId: input.runId,
          modelCallId,
          outputTokens: text.length,
        },
        { runId: input.runId, conversationId: input.conversationId },
      );

      return {
        text,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
        textPartId,
        firstTokenMs,
        modelCallId,
        protocolError,
      };
    } catch (error) {
      deltaThrottle.flush();
      this.deps.eventBus.emit(
        "agent.model.failed",
        {
          runId: input.runId,
          modelCallId,
          error: {
            code: "AGENT_MODEL_CALL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        { runId: input.runId, conversationId: input.conversationId },
      );
      throw error;
    }
  }
}

function buildToolCalls(
  accumulators: Map<number, ToolCallAccumulator>,
): ToolCall[] {
  return [...accumulators.values()]
    .sort((a, b) => a.index - b.index)
    .filter((value) => value.id && value.functionName)
    .map((value) => ({
      id: value.id,
      type: "function" as const,
      function: {
        name: value.functionName,
        arguments: value.functionArguments || "{}",
      },
    }));
}
