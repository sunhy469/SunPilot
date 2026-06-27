import { createHash } from "node:crypto";
import type { AgentLoopResult } from "../../agent-kernel/loop-types.js";
import type { ApprovalDecisionResult } from "../../agent-kernel/persistence/repository-approval-decision-service.js";

/** §5.4: Validate image attachment integrity before entering agent loop. */
export function isImageAttachment(a: { type: string; name?: string }): boolean {
  return (
    a.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(a.name ?? "")
  );
}

export function assertUsableImageAttachments(input: {
  message: string;
  attachments?: Array<{
    id: string;
    name: string;
    type: string;
    url?: string;
    dataUrl?: string;
    storageKey?: string;
  }>;
}): void {
  const imageKeywords = /1688|货源|同款|搜图|图片|相机|商品/i;
  if (!imageKeywords.test(input.message)) return;

  const imageAttachments = (input.attachments ?? []).filter(isImageAttachment);

  // If current request has image attachments, validate they have usable references.
  // If current request has NO image attachments, don't reject — the Agent Loop's
  // ToolArgumentBuilder will resolve historical image attachments from conversation context.
  if (imageAttachments.length === 0) return;

  const hasUsableRef = imageAttachments.some(
    (a) => a.url || a.dataUrl || a.storageKey,
  );
  if (!hasUsableRef) {
    throw Object.assign(
      new Error("上传的图片缺少可用引用，请重新上传后再试。"),
      { code: "IMAGE_ATTACHMENT_REF_MISSING", category: "input_validation", retryable: false },
    );
  }
}

export function hashIdempotencyRequest(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeIdempotencyResponse(
  response: unknown,
): AgentLoopResult & { conversationId: string; messageId: string } {
  if (!response || typeof response !== "object") {
    throw Object.assign(new Error("Idempotency response is unavailable."), {
      code: "AGENT_IDEMPOTENCY_CONFLICT",
      category: "idempotency",
      retryable: true,
    });
  }
  return response as AgentLoopResult & {
    conversationId: string;
    messageId: string;
  };
}

export function normalizeIdempotencyError(error: unknown): {
  code: string;
  category: string;
  retryable: boolean;
  message: string;
} {
  if (error && typeof error === "object") {
    const record = error as {
      code?: unknown;
      category?: unknown;
      retryable?: unknown;
      message?: unknown;
    };
    return {
      code:
        typeof record.code === "string" ? record.code : "AGENT_INTERNAL_ERROR",
      category:
        typeof record.category === "string" ? record.category : "internal",
      retryable:
        typeof record.retryable === "boolean" ? record.retryable : false,
      message:
        typeof record.message === "string"
          ? record.message
          : "Agent request failed.",
    };
  }
  return {
    code: "AGENT_INTERNAL_ERROR",
    category: "internal",
    retryable: false,
    message: String(error),
  };
}

export function hasPersistedApprovalEvent(
  approval: unknown,
): approval is ApprovalDecisionResult {
  return (
    typeof approval === "object" && approval !== null && "event" in approval
  );
}

export function isAttemptableStatus(status: unknown): boolean {
  return (
    status === "interrupted" || status === "failed" || status === "cancelled"
  );
}

export function normalizeAttemptMode(mode: unknown): "chat" | "agent" {
  return mode === "chat" ? mode : "agent";
}

export function messageFromRun(run: { goal?: string; input?: unknown }): string {
  if (typeof run.goal === "string" && run.goal.trim()) return run.goal;
  const input = run.input;
  if (input && typeof input === "object") {
    const record = input as { message?: unknown };
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
  }
  throw Object.assign(new Error("Run does not contain a resumable message."), {
    code: "AGENT_RUN_NOT_RESUMABLE",
    category: "run_state",
    retryable: false,
  });
}

/**
 * §5.3: Extract attachments from a run's stored input for retry/resume.
 * The source run stores `{ message, attachments, client }` in its input field.
 * Returns undefined when no attachments are stored (e.g. original request had none).
 */
export function extractAttachments(
  input: unknown,
): Array<{
  id: string;
  name: string;
  type: string;
  sizeBytes?: number;
  url?: string;
  dataUrl?: string;
  storageKey?: string;
  provider?: "aliyun-oss" | "s3" | "minio" | "local";
  checksum?: string;
}> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as { attachments?: unknown };
  if (!Array.isArray(record.attachments) || record.attachments.length === 0) {
    return undefined;
  }
  return record.attachments as Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes?: number;
    url?: string;
    dataUrl?: string;
    storageKey?: string;
    provider?: "aliyun-oss" | "s3" | "minio" | "local";
    checksum?: string;
  }>;
}
