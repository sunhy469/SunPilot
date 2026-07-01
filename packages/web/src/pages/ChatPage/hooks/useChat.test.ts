import { describe, expect, test } from "vitest";
import {
  AGENT_EVENT_VISIBILITY,
  assistantMessageReducer,
  lastDeltaIndexByPartId,
  parseSocketPayload,
} from "./chat/chat-state";
import type {
  ChatMessage,
  AssistantMessagePart,
} from "../../../features/conversations/types";
import { mergeMessagesById } from "./conversation-message-merge";
import { AGENT_EVENT_TYPES } from "@sunpilot/protocol";

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

  test("agent.message.completed tolerates missing parts and preserves existing stream parts", () => {
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
          content: "final",
        },
      },
      "conv_1",
    );

    expect(result[0]!.content).toBe("final");
    expect(result[0]!.status).toBe("completed");
    expect(result[0]!.parts).toHaveLength(1);
    expect(result[0]!.parts![0]).toMatchObject({
      id: "part_1",
      status: "completed",
    });
  });

  test("agent.message.completed without parts creates a final text part for late messages", () => {
    const result = assistantMessageReducer(
      [],
      {
        method: "agent.message.completed",
        params: {
          messageId: "msg_late",
          conversationId: "conv_1",
          content: "late final",
        },
      },
      "conv_1",
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("late final");
    expect(result[0]!.parts).toHaveLength(1);
    expect(result[0]!.parts![0]).toMatchObject({
      type: "text",
      content: "late final",
      status: "completed",
    });
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
  test("preserves canonical interleaved history when local replay has assistants only", () => {
    const serverUser = makeUserMessage({
      id: "user_history",
      createdAt: "2026-06-27T01:00:00.000Z",
    });
    const serverAssistant = makeStreamingAssistant({
      id: "assistant_history",
      content: "done",
      status: "completed",
      createdAt: "2026-06-27T01:00:01.000Z",
    });
    const localAssistant = { ...serverAssistant, content: "event replay" };

    const result = mergeMessagesById(
      [localAssistant],
      [serverUser, serverAssistant],
    );

    expect(result.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.map((message) => message.id)).toEqual([
      "user_history",
      "assistant_history",
    ]);
  });

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
  test("parses newly added canonical events through the visibility map", () => {
    const parsed = parseSocketPayload(JSON.stringify({
      jsonrpc: "2.0",
      method: "agent.react.turn.completed",
      params: {
        eventId: "evt_turn",
        sequence: 7,
        runId: "run_1",
        conversationId: "conv_1",
        createdAt: "2026-07-01T00:00:00.000Z",
        payload: { runId: "run_1", iteration: 1 },
      },
    }));

    expect(parsed).toMatchObject({
      method: "agent.react.turn.completed",
      id: "evt_turn",
      conversationId: "conv_1",
    });
  });

  test("all known events are classified", () => {
    const knownEvents = [...AGENT_EVENT_TYPES, "pong"];

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
      "agent.safety.injection_detected",
      "agent.safety.sandbox_denied",
      "agent.safety.scope_reauth_required",
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
            metadata: { phase: "queued" },
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
            label: "正在思考",
            status: "running",
            runId: "run_1",
            createdAt: "",
            metadata: { phase: "context_building" },
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
      label: "正在思考",
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
            metadata: { phase: "queued" },
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
