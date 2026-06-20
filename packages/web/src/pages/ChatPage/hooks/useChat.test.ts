import { describe, expect, test } from "vitest";
import type {
  ChatMessage,
  AssistantMessagePart,
} from "../../../features/conversations/types";

// ── Re-implement the pure functions for unit testing ──
// These are copied from useChat.ts and useConversations.ts since they are
// not exported. When they are extracted to a shared module, import them instead.

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}

const lastDeltaIndexByPartId = new Map<string, number>();

function assistantMessageReducer(
  items: ChatMessage[],
  event: { method: string; params: Record<string, unknown> },
  conversationId: string,
): ChatMessage[] {
  if (event.method === "agent.message.started") {
    const msgParams = event.params as {
      runId: string;
      conversationId: string;
      messageId: string;
    };

    if (items.some((m) => m.id === msgParams.messageId)) {
      return items.map((m) =>
        m.id === msgParams.messageId
          ? {
              ...m,
              status: "streaming" as const,
              parts: (m.parts ?? []).length > 0 ? m.parts : [{
                id: "__local_pending",
                type: "status",
                label: "正在理解需求...",
                status: "running",
                runId: "",
                createdAt: "",
                metadata: { phase: "local_pending" },
              }],
            }
          : m,
      );
    }

    const pendingPlaceholderIdx = findLastIndex(
      items,
      (m) =>
        m.role === "assistant" &&
        m.status === "pending" &&
        (m.conversationId === "pending" ||
          m.conversationId === (msgParams.conversationId || conversationId)),
    );

    if (pendingPlaceholderIdx >= 0) {
      return items.map((m, idx) =>
        idx === pendingPlaceholderIdx
          ? {
              ...m,
              id: msgParams.messageId,
              conversationId: msgParams.conversationId ?? conversationId,
              status: "streaming" as const,
              parts: [{
                id: "__local_pending",
                type: "status",
                label: "正在理解需求...",
                status: "running",
                runId: "",
                createdAt: "",
                metadata: { phase: "local_pending" },
              }],
            }
          : m,
      );
    }

    return [
      ...items,
      {
        id: msgParams.messageId,
        conversationId: msgParams.conversationId ?? conversationId,
        role: "assistant" as const,
        content: "",
        createdAt: new Date().toISOString(),
        status: "streaming" as const,
        activities: [],
        parts: [{
          id: "__local_pending",
          type: "status",
          label: "正在理解需求...",
          status: "running",
          runId: "",
          createdAt: "",
          metadata: { phase: "local_pending" },
        }],
      },
    ];
  }

  if (event.method === "agent.message.part.started") {
    const partParams = event.params as {
      messageId: string;
      part: Record<string, unknown>;
    };
    const partId = partParams.part.id as string | undefined;
    const incomingPart = partParams.part as unknown as AssistantMessagePart;

    return items.map((item) => {
      if (item.id !== partParams.messageId) return item;
      const parts = item.parts ?? [];
      // Remove local pending placeholder when the first real part arrives
      const withoutLocal = parts.filter((p) => p.id !== "__local_pending");
      const existingIdx =
        partId != null ? withoutLocal.findIndex((p) => p.id === partId) : -1;
      const nextParts =
        existingIdx >= 0
          ? withoutLocal.map((p, i) =>
              i === existingIdx
                ? ({ ...p, ...incomingPart } as AssistantMessagePart)
                : p,
            )
          : [...withoutLocal, incomingPart as AssistantMessagePart];
      return { ...item, parts: nextParts };
    });
  }

  if (event.method === "agent.message.part.delta") {
    const deltaParams = event.params as {
      conversationId?: string;
      messageId: string;
      partId: string;
      delta: string;
      deltaIndex?: number;
    };

    if (typeof deltaParams.deltaIndex === "number") {
      const key = `${deltaParams.messageId}:${deltaParams.partId}`;
      const lastIndex = lastDeltaIndexByPartId.get(key) ?? -1;
      if (deltaParams.deltaIndex <= lastIndex) {
        return items;
      }
      lastDeltaIndexByPartId.set(key, deltaParams.deltaIndex);
    }

    // Inline upsertTextPartDelta logic
    const existing = items.find((m) => m.id === deltaParams.messageId);
    if (existing && existing.status === "completed") return items;

    const applyDelta = (item: ChatMessage): ChatMessage => {
      const parts = item.parts ?? [];
      const hasPart = parts.some((part) => part.id === deltaParams.partId);
      const nextParts = hasPart
        ? parts.map((part) =>
            part.type === "text" && part.id === deltaParams.partId
              ? { ...part, content: (part.content ?? "") + deltaParams.delta }
              : part,
          )
        : [
            ...parts,
            {
              id: deltaParams.partId,
              type: "text" as const,
              content: deltaParams.delta,
              source: "model" as const,
              status: "streaming" as const,
              createdAt: new Date().toISOString(),
            },
          ];
      return { ...item, status: "streaming", parts: nextParts };
    };

    let found = false;
    const updated = items.map((item) => {
      if (item.id !== deltaParams.messageId) return item;
      found = true;
      return applyDelta(item);
    });
    if (found) return updated;

    return [
      ...items,
      applyDelta({
        id: deltaParams.messageId,
        conversationId: deltaParams.conversationId ?? conversationId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        status: "streaming",
        activities: [],
        parts: [],
      }),
    ];
  }

  if (event.method === "agent.message.part.updated") {
    const updateParams = event.params as {
      messageId: string;
      partId: string;
      patch: Record<string, unknown>;
    };
    return items.map((item) =>
      item.id === updateParams.messageId
        ? {
            ...item,
            parts: (item.parts ?? []).map((part) =>
              part.id === updateParams.partId
                ? { ...part, ...updateParams.patch }
                : part,
            ),
          }
        : item,
    );
  }

  if (event.method === "agent.message.completed") {
    const completedParams = event.params as {
      runId?: string;
      conversationId?: string;
      messageId: string;
      content: string;
      parts: Array<Record<string, unknown>>;
      cards?: Array<{
        type: string;
        title?: string;
        data: Record<string, unknown>;
      }>;
    };
    const completedParts = normalizeCompletedAssistantParts(
      completedParams.parts,
    );

    const existing = items.find((m) => m.id === completedParams.messageId);
    if (
      existing &&
      existing.status === "completed" &&
      existing.content === completedParams.content &&
      !hasOpenAssistantParts(existing.parts)
    ) {
      return items;
    }

    if (existing) {
      for (const key of lastDeltaIndexByPartId.keys()) {
        if (key.startsWith(completedParams.messageId + ":")) {
          lastDeltaIndexByPartId.delete(key);
        }
      }
      return items.map((m) =>
        m.id === completedParams.messageId
          ? {
              ...m,
              content: completedParams.content,
              parts: completedParts,
              status: "completed" as const,
              cards: (completedParams.cards as ChatMessage["cards"]) ?? m.cards,
            }
          : m,
      );
    }

    return [
      ...items,
      {
        id: completedParams.messageId,
        conversationId: completedParams.conversationId ?? conversationId,
        role: "assistant" as const,
        content: completedParams.content,
        createdAt: new Date().toISOString(),
        status: "completed" as const,
        activities: [],
        parts: completedParts,
        cards: completedParams.cards as ChatMessage["cards"],
      },
    ];
  }

  return items;
}

function hasOpenAssistantParts(parts?: ChatMessage["parts"]): boolean {
  return (parts ?? []).some((part) => {
    if (part.type === "status") return part.status === "running";
    if (part.type === "tool_use")
      return part.status === "pending" || part.status === "running";
    if (part.type === "text") return part.status === "streaming";
    return false;
  });
}

function normalizeCompletedAssistantParts(
  parts: Array<Record<string, unknown>>,
): ChatMessage["parts"] {
  const completedAt = new Date().toISOString();
  return parts.map((part) => {
    if (part.type === "status" && part.status === "running") {
      const metadata =
        part.metadata && typeof part.metadata === "object"
          ? (part.metadata as Record<string, unknown>)
          : {};
      return {
        ...part,
        status: "completed",
        completedAt:
          typeof part.completedAt === "string" ? part.completedAt : completedAt,
        metadata: {
          ...metadata,
          phase: "completed",
        },
      } as unknown as AssistantMessagePart;
    }
    if (
      part.type === "tool_use" &&
      (part.status === "pending" || part.status === "running")
    ) {
      return {
        ...part,
        status: "completed",
      } as unknown as AssistantMessagePart;
    }
    if (part.type === "text" && part.status === "streaming") {
      return {
        ...part,
        status: "completed",
        completedAt:
          typeof part.completedAt === "string" ? part.completedAt : completedAt,
      } as unknown as AssistantMessagePart;
    }
    return part as unknown as AssistantMessagePart;
  });
}

function mergeMessagesById(
  localMessages: ChatMessage[],
  serverMessages: ChatMessage[],
): ChatMessage[] {
  const serverById = new Map<string, ChatMessage>();
  for (const msg of serverMessages) {
    serverById.set(msg.id, msg);
  }

  const result: ChatMessage[] = [];
  const seenIds = new Set<string>();

  for (const local of localMessages) {
    const serverVersion = serverById.get(local.id);
    if (serverVersion) {
      result.push(serverVersion);
      seenIds.add(local.id);
    } else if (
      local.role === "assistant" &&
      (local.status === "pending" || local.status === "streaming")
    ) {
      result.push(local);
      seenIds.add(local.id);
    } else if (local.conversationId === "pending") {
      result.push(local);
      seenIds.add(local.id);
    } else {
      result.push(local);
      seenIds.add(local.id);
    }
  }

  for (const server of serverMessages) {
    if (!seenIds.has(server.id)) {
      result.push(server);
    }
  }

  return result;
}

// ── Helper to create test messages ──

function makeUserMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "user_1",
    conversationId: "conv_1",
    role: "user",
    content: "Hello",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePendingAssistant(
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: "local_1",
    conversationId: "pending",
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

function makeStreamingAssistant(
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: "msg_1",
    conversationId: "conv_1",
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    status: "streaming",
    parts: [],
    activities: [],
    ...overrides,
  };
}

// ── Tests ──

describe("assistantMessageReducer", () => {
  test("agent.message.started binds to pending placeholder with conversationId=pending", () => {
    const items: ChatMessage[] = [makeUserMessage(), makePendingAssistant()];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.started",
        params: {
          runId: "run_1",
          conversationId: "conv_1",
          messageId: "msg_real_1",
        },
      },
      "conv_1",
    );

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("msg_real_1");
    expect(result[1]!.conversationId).toBe("conv_1");
    expect(result[1]!.status).toBe("streaming");
  });

  test("agent.message.started does not duplicate if messageId already exists", () => {
    const items: ChatMessage[] = [
      makeUserMessage(),
      makeStreamingAssistant({ id: "msg_real_1" }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.started",
        params: {
          runId: "run_1",
          conversationId: "conv_1",
          messageId: "msg_real_1",
        },
      },
      "conv_1",
    );

    expect(result).toHaveLength(2);
    // Should update status, not add a new message
    expect(result.filter((m) => m.id === "msg_real_1")).toHaveLength(1);
  });

  test("agent.message.started creates new assistant if no placeholder", () => {
    const items: ChatMessage[] = [makeUserMessage()];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.started",
        params: {
          runId: "run_1",
          conversationId: "conv_1",
          messageId: "msg_new",
        },
      },
      "conv_1",
    );

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("msg_new");
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.status).toBe("streaming");
  });

  test("agent.message.part.started appends new part", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({ id: "msg_1", parts: [] }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.part.started",
        params: {
          messageId: "msg_1",
          part: {
            id: "part_1",
            type: "text",
            content: "",
            status: "streaming",
          },
        },
      },
      "conv_1",
    );

    expect(result[0]!.parts).toHaveLength(1);
    expect(result[0]!.parts![0]!.id).toBe("part_1");
  });

  test("agent.message.part.started upserts by part.id (idempotent)", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        parts: [
          {
            id: "part_1",
            type: "text",
            content: "hello",
            source: "model",
            status: "streaming",
            createdAt: "",
          },
        ],
      }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.part.started",
        params: {
          messageId: "msg_1",
          part: {
            id: "part_1",
            type: "text",
            content: "hello",
            status: "streaming",
          },
        },
      },
      "conv_1",
    );

    // Should NOT duplicate the part
    expect(result[0]!.parts).toHaveLength(1);
    expect(result[0]!.parts![0]!.id).toBe("part_1");
  });

  test("agent.message.completed replaces content (idempotent final override)", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        content: "partial",
        parts: [
          {
            id: "part_1",
            type: "text",
            content: "partial",
            source: "model",
            status: "streaming",
            createdAt: "",
          },
        ],
      }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.completed",
        params: {
          messageId: "msg_1",
          content: "final complete content",
          parts: [
            {
              id: "part_1",
              type: "text",
              content: "final complete content",
              status: "completed",
            },
          ],
        },
      },
      "conv_1",
    );

    expect(result[0]!.content).toBe("final complete content");
    expect(result[0]!.status).toBe("completed");
  });

  test("agent.message.completed is idempotent (same content = no change)", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        content: "done",
        status: "completed",
      }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.completed",
        params: {
          messageId: "msg_1",
          content: "done",
          parts: [],
        },
      },
      "conv_1",
    );

    // Should return the same reference (no re-render)
    expect(result).toBe(items);
  });

  test("agent.message.completed closes leftover running parts", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        content: "final",
        status: "completed",
        parts: [
          {
            id: "status_1",
            type: "status",
            label: "正在整理结果...",
            status: "running",
            runId: "run_1",
            createdAt: "",
            metadata: { phase: "running" },
          },
          {
            id: "text_1",
            type: "text",
            content: "final",
            source: "model",
            status: "streaming",
            createdAt: "",
          },
        ],
      }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.completed",
        params: {
          messageId: "msg_1",
          content: "final",
          parts: items[0]!.parts as unknown as Array<Record<string, unknown>>,
        },
      },
      "conv_1",
    );

    expect(result).not.toBe(items);
    expect(
      result[0]!.parts?.find((part) => part.id === "status_1"),
    ).toMatchObject({
      status: "completed",
      metadata: { phase: "completed" },
    });
    expect(
      result[0]!.parts?.find((part) => part.id === "text_1"),
    ).toMatchObject({
      status: "completed",
    });
  });

  test("agent.message.completed creates message if not found", () => {
    const items: ChatMessage[] = [makeUserMessage()];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.completed",
        params: {
          messageId: "msg_late",
          conversationId: "conv_1",
          content: "late arrival",
          parts: [],
        },
      },
      "conv_1",
    );

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("msg_late");
    expect(result[1]!.status).toBe("completed");
    expect(result[1]!.content).toBe("late arrival");
  });

  test("delta dedup: skips duplicate deltaIndex", () => {
    lastDeltaIndexByPartId.clear();
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        parts: [
          {
            id: "part_1",
            type: "text",
            content: "hel",
            source: "model",
            status: "streaming",
            createdAt: "",
          },
        ],
      }),
    ];

    // First delta with index 0
    const r1 = assistantMessageReducer(
      items,
      {
        method: "agent.message.part.delta",
        params: {
          messageId: "msg_1",
          partId: "part_1",
          delta: "lo",
          deltaIndex: 0,
        },
      },
      "conv_1",
    );

    // Duplicate delta with same index 0 should be skipped
    const r2 = assistantMessageReducer(
      r1,
      {
        method: "agent.message.part.delta",
        params: {
          messageId: "msg_1",
          partId: "part_1",
          delta: "lo",
          deltaIndex: 0,
        },
      },
      "conv_1",
    );

    // Should be the same reference (no change)
    expect(r2).toBe(r1);
    lastDeltaIndexByPartId.clear();
  });

  test("delta dedup: allows higher deltaIndex", () => {
    lastDeltaIndexByPartId.clear();
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        parts: [
          {
            id: "part_1",
            type: "text",
            content: "",
            source: "model",
            status: "streaming",
            createdAt: "",
          },
        ],
      }),
    ];

    // Delta with index 0
    const r1 = assistantMessageReducer(
      items,
      {
        method: "agent.message.part.delta",
        params: {
          messageId: "msg_1",
          partId: "part_1",
          delta: "a",
          deltaIndex: 0,
        },
      },
      "conv_1",
    );

    // Delta with index 1 (should be accepted)
    const r2 = assistantMessageReducer(
      r1,
      {
        method: "agent.message.part.delta",
        params: {
          messageId: "msg_1",
          partId: "part_1",
          delta: "b",
          deltaIndex: 1,
        },
      },
      "conv_1",
    );

    const textPart = r2[0]!.parts!.find((p) => p.type === "text");
    expect(textPart!.content).toBe("ab");
    lastDeltaIndexByPartId.clear();
  });
});

describe("mergeMessagesById", () => {
  test("keeps local pending assistant when server has no match", () => {
    const local: ChatMessage[] = [
      makeUserMessage({ conversationId: "pending" }),
      makePendingAssistant(),
    ];
    const server: ChatMessage[] = [];

    const result = mergeMessagesById(local, server);
    expect(result).toHaveLength(2);
    expect(result[1]!.status).toBe("pending");
  });

  test("keeps local streaming assistant when server has no match", () => {
    const local: ChatMessage[] = [
      makeUserMessage(),
      makeStreamingAssistant({ status: "streaming" }),
    ];
    const server: ChatMessage[] = [
      makeUserMessage(), // Server has the user message
    ];

    const result = mergeMessagesById(local, server);
    expect(result).toHaveLength(2);
    expect(result.some((m) => m.status === "streaming")).toBe(true);
  });

  test("server completed message overrides local with same ID", () => {
    const local: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        content: "partial",
        status: "streaming",
      }),
    ];
    const server: ChatMessage[] = [
      {
        id: "msg_1",
        conversationId: "conv_1",
        role: "assistant",
        content: "final",
        createdAt: "",
        status: "completed",
      },
    ];

    const result = mergeMessagesById(local, server);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("final");
    expect(result[0]!.status).toBe("completed");
  });

  test("adds server messages not present locally", () => {
    const local: ChatMessage[] = [makeUserMessage()];
    const server: ChatMessage[] = [
      makeUserMessage(),
      {
        id: "msg_old",
        conversationId: "conv_1",
        role: "assistant",
        content: "old reply",
        createdAt: "",
        status: "completed",
      },
    ];

    const result = mergeMessagesById(local, server);
    expect(result).toHaveLength(2);
    expect(result.some((m) => m.id === "msg_old")).toBe(true);
  });

  test("keeps local pending user messages with conversationId=pending", () => {
    const local: ChatMessage[] = [
      makeUserMessage({ id: "local_user", conversationId: "pending" }),
      makePendingAssistant(),
    ];
    const server: ChatMessage[] = [];

    const result = mergeMessagesById(local, server);
    expect(result).toHaveLength(2);
    expect(result[0]!.conversationId).toBe("pending");
  });

  test("live completed + history merge does not duplicate", () => {
    // Scenario: local has a completed message from live events,
    // server also returns the same message from history
    const local: ChatMessage[] = [
      makeUserMessage({ id: "user_1" }),
      {
        id: "msg_1",
        conversationId: "conv_1",
        role: "assistant",
        content: "hello",
        createdAt: "",
        status: "completed",
      },
    ];
    const server: ChatMessage[] = [
      makeUserMessage({ id: "user_1" }),
      {
        id: "msg_1",
        conversationId: "conv_1",
        role: "assistant",
        content: "hello",
        createdAt: "",
        status: "completed",
      },
    ];

    const result = mergeMessagesById(local, server);
    expect(result).toHaveLength(2);
    // Only one assistant message
    expect(result.filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});

// ── §P1-4: AGENT_EVENT_VISIBILITY classification tests ──────────────

describe("AGENT_EVENT_VISIBILITY", () => {
  // Re-implement the visibility map for testing (mirrors useChat.ts)
  const AGENT_EVENT_VISIBILITY: Record<string, string> = {
    "agent.tool.started": "visible",
    "agent.tool.delta": "visible",
    "agent.tool.completed": "visible",
    "agent.tool.failed": "visible",
    "agent.error": "visible",
    "agent.run.created": "status",
    "agent.run.started": "status",
    "agent.run.completed": "status",
    "agent.run.failed": "status",
    "agent.run.cancelled": "status",
    "agent.run.interrupted": "status",
    "agent.message.started": "status",
    "agent.message.part.started": "status",
    "agent.message.part.delta": "status",
    "agent.message.part.updated": "status",
    "agent.message.completed": "status",
    "agent.approval.required": "status",
    "agent.approval.approved": "status",
    "agent.approval.rejected": "status",
    "agent.approval.expired": "status",
    "agent.artifact.created": "status",
    "agent.memory.written": "status",
    "agent.context.started": "debug",
    "agent.context.completed": "debug",
    "agent.intent.detected": "debug",
    "agent.plan.created": "debug",
    "agent.tool.selected": "debug",
    "agent.model.started": "debug",
    "agent.model.delta": "debug",
    "agent.model.completed": "debug",
    "agent.model.failed": "debug",
    "agent.clarification.requested": "debug",
    "pong": "ignored",
  };

  test("all known events are classified", () => {
    const knownEvents = [
      "agent.run.created", "agent.run.started", "agent.run.completed",
      "agent.run.failed", "agent.run.cancelled", "agent.run.interrupted",
      "agent.context.started", "agent.context.completed",
      "agent.intent.detected", "agent.plan.created",
      "agent.clarification.requested",
      "agent.model.started", "agent.model.delta", "agent.model.completed",
      "agent.model.failed",
      "agent.tool.selected", "agent.tool.started", "agent.tool.delta",
      "agent.tool.completed", "agent.tool.failed",
      "agent.approval.required", "agent.approval.approved",
      "agent.approval.rejected", "agent.approval.expired",
      "agent.artifact.created", "agent.memory.written",
      "agent.message.started", "agent.message.part.started",
      "agent.message.part.delta", "agent.message.part.updated",
      "agent.message.completed",
      "agent.error",
      "pong",
    ];

    for (const event of knownEvents) {
      expect(
        AGENT_EVENT_VISIBILITY[event],
        `Event "${event}" must be in AGENT_EVENT_VISIBILITY`,
      ).toBeDefined();
    }
  });

  test("only 'visible' events produce activities", () => {
    const visibleEvents = Object.entries(AGENT_EVENT_VISIBILITY)
      .filter(([, v]) => v === "visible")
      .map(([k]) => k);

    expect(visibleEvents).toEqual([
      "agent.tool.started",
      "agent.tool.delta",
      "agent.tool.completed",
      "agent.tool.failed",
      "agent.error",
    ]);
  });

  test("terminal events are classified as 'status'", () => {
    const terminalEvents = [
      "agent.run.completed",
      "agent.run.failed",
      "agent.run.cancelled",
      "agent.run.interrupted",
    ];
    for (const event of terminalEvents) {
      expect(AGENT_EVENT_VISIBILITY[event]).toBe("status");
    }
  });

  test("agent.run.started is classified as 'status' (not debug)", () => {
    expect(AGENT_EVENT_VISIBILITY["agent.run.started"]).toBe("status");
  });
});

// ── §P0-2 / §P1-1: assistantMessageReducer approval & status part tests ──

describe("assistantMessageReducer — approval status part updates", () => {
  test("agent.message.part.updated patches status part from running to failed", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        parts: [
          {
            id: "status_1",
            type: "status",
            label: "等待确认: searchTool",
            status: "running",
            runId: "run_1",
            createdAt: "",
            metadata: { phase: "queued" },
          },
        ],
      }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.part.updated",
        params: {
          messageId: "msg_1",
          partId: "status_1",
          patch: {
            status: "failed",
            label: "已拒绝: searchTool",
          },
        },
      },
      "conv_1",
    );

    const patched = result[0]!.parts!.find((p) => p.id === "status_1");
    expect(patched).toMatchObject({
      status: "failed",
      label: "已拒绝: searchTool",
    });
  });

  test("agent.message.part.updated patches status part from running to completed", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        parts: [
          {
            id: "status_1",
            type: "status",
            label: "等待确认: searchTool",
            status: "running",
            runId: "run_1",
            createdAt: "",
            metadata: { phase: "queued" },
          },
        ],
      }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.part.updated",
        params: {
          messageId: "msg_1",
          partId: "status_1",
          patch: {
            status: "completed",
            label: "已确认: searchTool",
          },
        },
      },
      "conv_1",
    );

    const patched = result[0]!.parts!.find((p) => p.id === "status_1");
    expect(patched).toMatchObject({
      status: "completed",
      label: "已确认: searchTool",
    });
  });

  test("agent.message.part.updated only patches the specified part", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        parts: [
          {
            id: "status_1",
            type: "status",
            label: "等待确认: toolA",
            status: "running",
            runId: "run_1",
            createdAt: "",
            metadata: {},
          },
          {
            id: "status_2",
            type: "status",
            label: "等待确认: toolB",
            status: "running",
            runId: "run_1",
            createdAt: "",
            metadata: {},
          },
        ],
      }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.part.updated",
        params: {
          messageId: "msg_1",
          partId: "status_1",
          patch: { status: "completed", label: "已确认: toolA" },
        },
      },
      "conv_1",
    );

    const part1 = result[0]!.parts!.find((p) => p.id === "status_1");
    const part2 = result[0]!.parts!.find((p) => p.id === "status_2");
    expect(part1).toMatchObject({ status: "completed" });
    expect(part2).toMatchObject({ status: "running" });
  });

  // ── §Status gap fix: local pending status part ─────────────────

  test("agent.message.started inserts local pending status part", () => {
    const items: ChatMessage[] = [];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.started",
        params: {
          runId: "run_1",
          conversationId: "conv_1",
          messageId: "msg_1",
        },
      },
      "conv_1",
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("streaming");
    expect(result[0]!.parts).toHaveLength(1);
    expect(result[0]!.parts![0]).toMatchObject({
      id: "__local_pending",
      type: "status",
      label: "正在理解需求...",
      status: "running",
    });
  });

  test("agent.message.started inserts local pending part only when no parts exist", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        parts: [
          {
            id: "status_real",
            type: "status",
            label: "正在思考",
            status: "running",
            runId: "run_1",
            createdAt: "",
            metadata: {},
          },
        ],
      }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.started",
        params: {
          runId: "run_1",
          conversationId: "conv_1",
          messageId: "msg_1",
        },
      },
      "conv_1",
    );

    // Should NOT insert local pending part when parts already exist
    expect(result[0]!.parts).toHaveLength(1);
    expect(result[0]!.parts![0]!.id).toBe("status_real");
  });

  test("agent.message.part.started removes local pending part and adds real part", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        parts: [
          {
            id: "__local_pending",
            type: "status",
            label: "正在理解需求...",
            status: "running",
            runId: "",
            createdAt: "",
            metadata: { phase: "local_pending" },
          },
        ],
      }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.part.started",
        params: {
          messageId: "msg_1",
          part: {
            id: "status_1",
            type: "status",
            label: "正在理解需求",
            status: "running",
            runId: "run_1",
            createdAt: "",
            metadata: { phase: "intent_routing" },
          },
        },
      },
      "conv_1",
    );

    // Local pending part should be removed
    expect(result[0]!.parts!.find((p) => p.id === "__local_pending")).toBeUndefined();
    // Real part should be present
    expect(result[0]!.parts).toHaveLength(1);
    expect(result[0]!.parts![0]).toMatchObject({
      id: "status_1",
      label: "正在理解需求",
    });
  });

  test("agent.message.completed removes local pending part via full parts replacement", () => {
    const items: ChatMessage[] = [
      makeStreamingAssistant({
        id: "msg_1",
        parts: [
          {
            id: "__local_pending",
            type: "status",
            label: "正在理解需求...",
            status: "running",
            runId: "",
            createdAt: "",
            metadata: { phase: "local_pending" },
          },
        ],
      }),
    ];

    const result = assistantMessageReducer(
      items,
      {
        method: "agent.message.completed",
        params: {
          runId: "run_1",
          conversationId: "conv_1",
          messageId: "msg_1",
          content: "Hello!",
          parts: [
            { id: "text_1", type: "text", content: "Hello!", runId: "run_1", createdAt: "" },
          ],
        },
      },
      "conv_1",
    );

    // Completed message replaces all parts, so local pending is gone
    expect(result[0]!.parts!.find((p) => p.id === "__local_pending")).toBeUndefined();
    expect(result[0]!.status).toBe("completed");
  });
});
