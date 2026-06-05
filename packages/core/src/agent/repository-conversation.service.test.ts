import { describe, expect, test } from "vitest";
import type { DatabaseContext } from "@sunpilot/storage";
import { RepositoryAgentConversationStore } from "./repository-conversation.service.js";

describe("RepositoryAgentConversationStore", () => {
  test("maps Agent conversation operations onto storage repositories", async () => {
    const calls: string[] = [];
    const store = new RepositoryAgentConversationStore({
      conversations: {
        async create(input) {
          calls.push(`conversation.create:${input?.title}`);
          return {
            id: "conv_1",
            title: input?.title,
            status: "active",
            createdAt: "2026-06-05T00:00:00.000Z",
            updatedAt: "2026-06-05T00:00:00.000Z"
          };
        },
        async findById(id) {
          calls.push(`conversation.find:${id}`);
          return {
            id,
            status: "active",
            createdAt: "2026-06-05T00:00:00.000Z",
            updatedAt: "2026-06-05T00:00:00.000Z"
          };
        },
        async list() {
          return [];
        },
        async touch(id) {
          calls.push(`conversation.touch:${id}`);
        }
      },
      messages: {
        async create(input) {
          calls.push(`message.create:${input.role}:${input.content}`);
          return {
            id: "msg_1",
            conversationId: input.conversationId,
            role: input.role,
            content: input.content,
            metadata: {},
            createdAt: "2026-06-05T00:00:00.000Z"
          };
        },
        async listByConversationId(conversationId) {
          calls.push(`message.list:${conversationId}`);
          return [
            {
              id: "msg_1",
              conversationId,
              role: "user",
              content: "hello",
              metadata: {},
              createdAt: "2026-06-05T00:00:00.000Z"
            }
          ];
        }
      }
    } satisfies Pick<DatabaseContext, "conversations" | "messages">);

    await expect(store.createConversation({ title: "Test" })).resolves.toMatchObject({ id: "conv_1", title: "Test" });
    await expect(store.findConversationById("conv_1")).resolves.toMatchObject({ id: "conv_1" });
    await store.touchConversation("conv_1");
    await expect(store.createMessage({ conversationId: "conv_1", role: "assistant", content: "ok" })).resolves.toMatchObject({ id: "msg_1", content: "ok" });
    await expect(store.listMessages("conv_1")).resolves.toEqual([expect.objectContaining({ role: "user", content: "hello" })]);
    expect(calls).toEqual([
      "conversation.create:Test",
      "conversation.find:conv_1",
      "conversation.touch:conv_1",
      "message.create:assistant:ok",
      "message.list:conv_1"
    ]);
  });
});
