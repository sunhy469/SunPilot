import type { ArtifactRef, ToolCallSummary } from "../../loop-types.js";
import type { ChatMessage, ToolCall } from "../../../llm/llm.types.js";

export function injectStreamingToolResults(
  messages: ChatMessage[],
  toolCalls: ToolCall[],
  results: { summaries: ToolCallSummary[]; artifacts: ArtifactRef[] },
  maxContextTokens?: number,
): ChatMessage[] {
  const updated = [...messages];

  updated.push({
    role: "assistant",
    content: "",
    tool_calls: toolCalls,
  });

  for (const summary of results.summaries) {
    const projection = projectToolResultForModel(summary, maxContextTokens);
    updated.push({
      role: "tool",
      content: projection.modelObservation,
      tool_call_id: summary.id,
    } satisfies ChatMessage);
  }

  return updated;
}

export function projectToolResultForModel(
  summary: ToolCallSummary,
  maxContextTokens?: number,
): {
  displaySummary: string;
  modelObservation: string;
  isFinalAnswer: boolean;
} {
  const statusPrefix =
    summary.status === "completed" ? "" : `[${summary.status.toUpperCase()}] `;
  const displaySummary = summary.summary;

  const hints = summary.metadata?.projectionHints as
    | { outputIsFinal?: boolean }
    | undefined;
  const isFinalAnswer =
    hints?.outputIsFinal === true && summary.status === "completed";

  let modelObservation: string;
  if (summary.modelObservation) {
    modelObservation = statusPrefix + summary.modelObservation;
  } else if (summary.content) {
    modelObservation = statusPrefix + summary.content;
  } else if (summary.structured && Object.keys(summary.structured).length > 0) {
    const outputFields = extractOutputFields(summary.structured);
    modelObservation = statusPrefix + outputFields;
  } else {
    modelObservation = statusPrefix + summary.summary;
  }

  const MAX_OBSERVATION_CHARS = Math.min(8000, (maxContextTokens ?? 128_000) * 2);
  if (modelObservation.length > MAX_OBSERVATION_CHARS) {
    modelObservation =
      modelObservation.slice(0, MAX_OBSERVATION_CHARS) +
      `…[truncated ${modelObservation.length - MAX_OBSERVATION_CHARS} chars]`;
  }

  return { displaySummary, modelObservation, isFinalAnswer };
}

function extractOutputFields(structured: Record<string, unknown>): string {
  const outputKeys = [
    "script",
    "markdown",
    "content",
    "finalText",
    "text",
    "body",
    "html",
    "message",
    "output",
    "result",
    "response",
  ];
  const parts: string[] = [];

  for (const key of outputKeys) {
    const val = structured[key];
    if (typeof val === "string" && val.length > 0) {
      parts.push(`[${key}]\n${val}`);
    }
  }

  if (
    Array.isArray(structured.candidates) &&
    structured.candidates.length > 0
  ) {
    parts.push(`[candidates: ${structured.candidates.length} items]`);
  }
  if (Array.isArray(structured.results) && structured.results.length > 0) {
    parts.push(`[results: ${structured.results.length} items]`);
  }
  if (typeof structured.totalResults === "number") {
    parts.push(`[totalResults: ${structured.totalResults}]`);
  }
  if (typeof structured.summary === "string" && parts.length === 0) {
    parts.push(structured.summary);
  }

  return parts.length > 0 ? parts.join("\n\n") : JSON.stringify(structured);
}
