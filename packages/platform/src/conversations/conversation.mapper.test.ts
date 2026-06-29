import { describe, expect, test } from "vitest";
import type { MessageRecord } from "@sunpilot/storage";
import { toHistoryMessageDto } from "./conversation.mapper.js";

function baseRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg_1",
    conversationId: "conv_1",
    role: "user",
    content: "Hello",
    metadata: {},
    createdAt: "2026-06-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("toHistoryMessageDto", () => {
  test("maps basic fields", () => {
    const dto = toHistoryMessageDto(baseRecord());
    expect(dto).toEqual({
      id: "msg_1",
      conversationId: "conv_1",
      role: "user",
      content: "Hello",
      createdAt: "2026-06-29T00:00:00.000Z",
      attachments: undefined,
      cards: undefined,
      parts: undefined,
    });
  });

  test("extracts attachments from metadata", () => {
    const record = baseRecord({
      metadata: { attachments: [{ id: "att_1", name: "file.pdf" }] },
    });
    expect(toHistoryMessageDto(record).attachments).toEqual([
      { id: "att_1", name: "file.pdf" },
    ]);
  });

  test("extracts richCards from metadata as cards", () => {
    const record = baseRecord({
      metadata: { richCards: [{ type: "info", title: "Card" }] },
    });
    expect(toHistoryMessageDto(record).cards).toEqual([
      { type: "info", title: "Card" },
    ]);
  });

  test("extracts parts from metadata", () => {
    const record = baseRecord({
      metadata: { parts: [{ type: "text", content: "part" }] },
    });
    expect(toHistoryMessageDto(record).parts).toEqual([
      { type: "text", content: "part" },
    ]);
  });

  test("returns undefined for missing metadata fields", () => {
    const dto = toHistoryMessageDto(baseRecord({ metadata: {} }));
    expect(dto.attachments).toBeUndefined();
    expect(dto.cards).toBeUndefined();
    expect(dto.parts).toBeUndefined();
  });

  test("preserves assistant role", () => {
    const dto = toHistoryMessageDto(baseRecord({ role: "assistant" }));
    expect(dto.role).toBe("assistant");
  });
});
