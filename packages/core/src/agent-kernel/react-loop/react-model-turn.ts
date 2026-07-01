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

const MAX_MODEL_TEXT_CHARS = 1_000_000;
const MAX_TOOL_CALLS_PER_TURN = 32;
const MAX_TOOL_ARGUMENT_CHARS = 256 * 1024;
const MAX_TOOL_IDENTIFIER_CHARS = 512;

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
    maxTokens?: number;
  }, signal: AbortSignal): Promise<ReactModelTurnResult> {
    const modelCallId = `model_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    let firstTokenMs = 0;
    let text = "";
    let providerFinishReason: string | undefined;
    let textPartId: string | undefined;
    const accumulators = new Map<number, ToolCallAccumulator>();
    const textualState: TextualCallStreamState = {
      buffering: false,
      probe: "",
      callBuffer: "",
    };

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
        "react_turn",
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
          maxTokens: input.maxTokens,
          metadata: { reactTurn: true, toolsDisabled: !!input.disableTools },
        },
        signal,
      )) {
        if (chunk.finishReason) providerFinishReason = chunk.finishReason;
        if (chunk.delta.length > 0) {
          if (firstTokenMs === 0) firstTokenMs = Date.now() - startedAt;

          const visibleDelta = consumeTextualCallDelta(textualState, chunk.delta);
          if (textualState.callBuffer.length > MAX_TOOL_ARGUMENT_CHARS) {
            throw modelProtocolLimitError("textual function call exceeded the runtime limit");
          }
          if (visibleDelta) {
            if (input.stream && !textPartId) {
              textPartId = input.stream.startTextPart(input.textRole).id;
            }
            text += visibleDelta;
            if (text.length > MAX_MODEL_TEXT_CHARS) {
              throw modelProtocolLimitError("model text output exceeded the runtime limit");
            }
            input.stream?.appendText(textPartId!, visibleDelta);
            deltaThrottle.push(visibleDelta);
          }
        }

        for (const delta of chunk.toolCalls ?? []) {
          if (firstTokenMs === 0) firstTokenMs = Date.now() - startedAt;
          let accumulator = accumulators.get(delta.index);
          if (!accumulator) {
            if (accumulators.size >= MAX_TOOL_CALLS_PER_TURN) {
              throw modelProtocolLimitError("too many tool calls in one model turn");
            }
            accumulator = {
              index: delta.index,
              id: "",
              type: "function",
              functionName: "",
              functionArguments: "",
            };
            accumulators.set(delta.index, accumulator);
          }
          if (delta.id) {
            if (delta.id.length > MAX_TOOL_IDENTIFIER_CHARS) {
              throw modelProtocolLimitError("tool_call_id exceeded the runtime limit");
            }
            accumulator.id = delta.id;
          }
          if (delta.function?.name) {
            if (delta.function.name.length > MAX_TOOL_IDENTIFIER_CHARS) {
              throw modelProtocolLimitError("tool function name exceeded the runtime limit");
            }
            accumulator.functionName = delta.function.name;
          }
          if (delta.function?.arguments) {
            accumulator.functionArguments += delta.function.arguments;
            if (accumulator.functionArguments.length > MAX_TOOL_ARGUMENT_CHARS) {
              throw modelProtocolLimitError("tool arguments exceeded the runtime limit");
            }
          }
        }
      }

      const trailingText = finishTextualCallStream(textualState);
      if (trailingText) {
        if (input.stream && !textPartId) {
          textPartId = input.stream.startTextPart(input.textRole).id;
        }
        text += trailingText;
        if (text.length > MAX_MODEL_TEXT_CHARS) {
          throw modelProtocolLimitError("model text output exceeded the runtime limit");
        }
        input.stream?.appendText(textPartId!, trailingText);
        deltaThrottle.push(trailingText);
      }
      deltaThrottle.flush();
      const completeNativeCalls = buildToolCalls(accumulators);
      const nativeCalls = deduplicateToolCallIds(completeNativeCalls);
      const textualCalls = input.disableTools
        ? []
        : parseTextualFunctionCalls(textualState.callBuffer, input.tools);
      const toolCalls = nativeCalls.length > 0 ? nativeCalls : textualCalls;
      const terminalProtocolError =
        providerFinishReason &&
        providerFinishReason !== "stop" &&
        providerFinishReason !== "tool_calls"
          ? `model stopped with finish_reason '${providerFinishReason}'`
          : providerFinishReason === "tool_calls" && completeNativeCalls.length === 0
            ? "model reported tool_calls without a complete native tool call"
            : undefined;
      const protocolError = terminalProtocolError ?? (
        accumulators.size > completeNativeCalls.length
          ? "incomplete native tool-call delta"
          : completeNativeCalls.length > nativeCalls.length
            ? "duplicate native tool_call_id"
          : textualState.callBuffer && textualCalls.length === 0
            ? "malformed textual function call"
            : undefined
      );

      this.deps.eventBus.emit(
        "agent.model.completed",
        {
          runId: input.runId,
          modelCallId,
          outputTokens: text.length,
          finishReason: providerFinishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
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

function modelProtocolLimitError(message: string): Error {
  return Object.assign(new Error(message), {
    code: "AGENT_MODEL_OUTPUT_TOO_LARGE",
    category: "model_protocol",
    retryable: false,
  });
}

const TEXTUAL_CALL_BEGIN = "<FunctionCallBegin>";
const TEXTUAL_CALL_END = "<FunctionCallEnd>";

interface TextualCallStreamState {
  buffering: boolean;
  /** Possible prefix of the begin marker, withheld from visible streaming. */
  probe: string;
  callBuffer: string;
}

function consumeTextualCallDelta(
  state: TextualCallStreamState,
  delta: string,
): string {
  let input = state.probe + delta;
  state.probe = "";
  let visible = "";

  while (input) {
    if (state.buffering) {
      const end = input.indexOf(TEXTUAL_CALL_END);
      if (end < 0) {
        state.callBuffer += input;
        return visible;
      }
      const boundary = end + TEXTUAL_CALL_END.length;
      state.callBuffer += input.slice(0, boundary);
      state.buffering = false;
      input = input.slice(boundary);
      continue;
    }

    const begin = input.indexOf(TEXTUAL_CALL_BEGIN);
    if (begin >= 0) {
      visible += input.slice(0, begin);
      state.callBuffer += TEXTUAL_CALL_BEGIN;
      state.buffering = true;
      input = input.slice(begin + TEXTUAL_CALL_BEGIN.length);
      continue;
    }

    const withheld = longestMarkerPrefixSuffix(input, TEXTUAL_CALL_BEGIN);
    visible += input.slice(0, input.length - withheld);
    state.probe = input.slice(input.length - withheld);
    return visible;
  }
  return visible;
}

function finishTextualCallStream(state: TextualCallStreamState): string {
  if (state.buffering) {
    state.callBuffer += state.probe;
    state.probe = "";
    return "";
  }
  const trailing = state.probe;
  state.probe = "";
  return trailing;
}

function longestMarkerPrefixSuffix(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let size = max; size > 0; size--) {
    if (value.endsWith(marker.slice(0, size))) return size;
  }
  return 0;
}

function deduplicateToolCallIds(calls: ToolCall[]): ToolCall[] {
  const ids = new Set<string>();
  return calls.filter((call) => {
    if (ids.has(call.id)) return false;
    ids.add(call.id);
    return true;
  });
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
