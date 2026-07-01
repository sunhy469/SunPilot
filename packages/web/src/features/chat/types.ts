export interface AttachmentRef {
  id: string;
  name: string;
  type: string;
  sizeBytes?: number;
  url?: string;
  /** Base64-encoded data URL as fallback when no public URL is available. */
  dataUrl?: string;
  storageKey?: string;
  provider?: "aliyun-oss" | "s3" | "minio" | "local";
  checksum?: string;
}

type ChatModelId = "dp" | "seed";

export interface ChatSendParams {
  conversationId?: string;
  message: string;
  mode?: "chat" | "agent";
  permissionMode?: "ask" | "auto" | "full";
  /** User-selected chat model. When unset, the default model is used. */
  modelId?: ChatModelId;
  clientRequestId?: string;
  attachments?: AttachmentRef[];
}

// ── Wire event types (what comes over WebSocket) ────────────────────

/** Raw wire envelope metadata carried in every WebSocket notification. */
interface AgentWireEnvelope<TPayload = Record<string, unknown>> {
  eventId: string;
  sequence: number;
  runId?: string;
  conversationId?: string;
  createdAt: string;
  payload: TPayload;
}

/** Wire-level event as received from the WebSocket. */
type AgentWireEvent = {
  jsonrpc: "2.0";
  method: string;
  params: AgentWireEnvelope;
};

// ── UI event types (consumed by React components) ───────────────────

/** Metadata extracted from the wire envelope for UI consumption. */
interface AgentSocketEnvelopeMetadata {
  id?: string;
  sequence?: number;
  runId?: string;
  conversationId?: string;
  createdAt?: string;
}

/**
 * Normalized UI event — components consume this, NOT the raw wire event.
 * parseSocketPayload() is responsible for converting AgentWireEvent → AgentUiEvent.
 */
export type AgentUiEvent = AgentSocketEnvelopeMetadata &
  (
    | {
        method: "agent.run.created";
        params: {
          runId: string;
          conversationId: string;
          mode: string;
          goal?: string;
        };
      }
    | {
        method: "agent.run.started";
        params: {
          runId: string;
          conversationId?: string;
          originalRunId?: string;
          attemptAction?: string;
        };
      }
    | {
        method: "agent.context.started";
        params: { runId: string };
      }
    | {
        method: "agent.context.completed";
        params: {
          runId: string;
          tokenEstimate?: number;
          included?: {
            messages?: number;
            memories?: number;
            artifacts?: number;
            toolResults?: number;
          };
        };
      }
    | {
        method: "agent.intent.detected";
        params: {
          runId: string;
          intent: string;
          confidence?: number;
          candidateSkills?: string[];
        };
      }
    | {
        method: "agent.plan.created";
        params: {
          runId: string;
          plan?: {
            id?: string;
            goal?: string;
            summary?: string;
            steps?: number;
          };
        };
      }
    | {
        method: "agent.clarification.requested";
        params: {
          runId: string;
          conversationId?: string;
          messageId: string;
          question: string;
          reason?: string;
        };
      }
    | {
        method: "agent.model.started";
        params: {
          runId: string;
          modelCallId: string;
          provider: string;
          model: string;
        };
      }
    | {
        method: "agent.model.delta";
        params: { runId: string; modelCallId: string; delta: string };
      }
    | {
        method: "agent.model.completed";
        params: {
          runId: string;
          modelCallId: string;
          inputTokens?: number;
          outputTokens?: number;
        };
      }
    | {
        method: "agent.model.failed";
        params: {
          runId: string;
          modelCallId: string;
          error: {
            code: string;
            message: string;
            category?: string;
            retryable?: boolean;
          };
        };
      }
    | {
        method: "agent.run.completed";
        params: {
          runId: string;
          assistantMessageId?: string;
          artifacts: string[];
          toolCalls: number;
        };
      }
    | {
        method: "agent.run.failed";
        params: { runId: string; error: { code: string; message: string } };
      }
    | {
        method: "agent.run.cancelled";
        params: { runId: string; reason?: string };
      }
    | {
        method: "agent.run.interrupted";
        params: { runId: string; reason?: string };
      }
    | {
        method: "agent.error";
        params: {
          runId?: string;
          conversationId?: string;
          code?: string;
          message?: string;
          fatal?: boolean;
          error?: { message: string; code?: string };
        };
      }
    | {
        method: "agent.tool.started";
        params: {
          runId: string;
          toolCallId: string;
          skillId: string;
          name: string;
        };
      }
    | {
        method: "agent.tool.selected";
        params: {
          runId: string;
          toolCallId: string;
          skillId: string;
          name: string;
          riskLevel?: string;
        };
      }
    | {
        method: "agent.tool.completed";
        params: {
          runId: string;
          toolCallId: string;
          skillId?: string;
          summary: string;
          artifacts?: string[];
        };
      }
    | {
        method: "agent.tool.delta";
        params: {
          runId: string;
          toolCallId: string;
          delta: string;
        };
      }
    | {
        method: "agent.tool.failed";
        params: {
          runId: string;
          toolCallId: string;
          skillId?: string;
          error: { code?: string; message: string };
        };
      }
    | {
        method: "agent.approval.approved";
        params: {
          runId: string;
          approvalId: string;
          decidedBy?: string;
        };
      }
    | {
        method: "agent.approval.rejected";
        params: {
          runId: string;
          approvalId: string;
          decidedBy?: string;
          reason?: string;
          strategy?: string;
        };
      }
    | {
        method: "agent.approval.required";
        params: {
          runId: string;
          approvalId: string;
          title: string;
          riskLevel: string;
        };
      }
    | {
        method: "agent.approval.expired";
        params: {
          runId: string;
          approvalId: string;
          title?: string;
          riskLevel?: string;
          runCancelled?: boolean;
        };
      }
    | {
        method: "agent.artifact.created";
        params: {
          runId: string;
          artifactId: string;
          name?: string;
          type?: string;
        };
      }
    | {
        method: "agent.memory.written";
        params: {
          runId: string;
          memoryId: string;
          type?: string;
          scope?: string;
        };
      }
    // ── Message content-block events (§Phase 1) ──────────────
    | {
        method: "agent.message.started";
        params: {
          runId: string;
          conversationId: string;
          messageId: string;
        };
      }
    | {
        method: "agent.message.part.started";
        params: {
          runId: string;
          conversationId: string;
          messageId: string;
          part: Record<string, unknown>;
        };
      }
    | {
        method: "agent.message.part.delta";
        params: {
          runId: string;
          conversationId: string;
          messageId: string;
          partId: string;
          delta: string;
        };
      }
    | {
        method: "agent.message.part.updated";
        params: {
          runId: string;
          conversationId: string;
          messageId: string;
          partId: string;
          patch: Record<string, unknown>;
        };
      }
    | {
        method: "agent.message.completed";
        params: {
          runId?: string;
          conversationId?: string;
          messageId: string;
          content: string;
          parts: Array<Record<string, unknown>>;
        };
      }
  );

export type ChatSocketEvent =
  | AgentUiEvent
  | { method: "pong"; params: Record<string, never> };

export type ChatStopParams = {
  runId: string;
};

export interface RunResumeParams {
  runId: string;
  message: string;
  attachments?: AttachmentRef[];
}

export interface ChatSocketErrorResponse {
  error: { message: string };
}
