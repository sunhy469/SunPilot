import { describe, expect, test } from "vitest";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  OpenAICompatibleChatProvider,
} from "./llm.js";

describe("OpenAICompatibleChatProvider", () => {
  test("uses DeepSeek defaults and streams OpenAI-compatible chat deltas", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const provider = new OpenAICompatibleChatProvider(
      { apiKey: "test-key" },
      async (input, init) => {
        calls.push({ input, init });
        return new Response(
          [
            'data: {"id":"chatcmpl_1","model":"deepseek-v4-flash","choices":[{"delta":{"role":"assistant","content":"he"}}]}',
            "",
            'data: {"id":"chatcmpl_1","model":"deepseek-v4-flash","choices":[{"delta":{"content":"llo"}}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    );

    const deltas: string[] = [];
    for await (const chunk of provider.streamChat({
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 16,
    })) {
      deltas.push(chunk.delta);
    }

    expect(deltas).toEqual(["he", "llo"]);
    expect(String(calls[0]?.input)).toBe(
      `${DEFAULT_LLM_BASE_URL}/chat/completions`,
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer test-key",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      model: DEFAULT_LLM_MODEL,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
      stream: true,
    });
  });

  test("preserves provider base URL paths when building the chat completions endpoint", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const provider = new OpenAICompatibleChatProvider(
      {
        apiKey: "seed-key",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        model: "doubao-seed-2-0-lite-260428",
      },
      async (input, init) => {
        calls.push({ input, init });
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    );

    for await (const _chunk of provider.streamChat({
      messages: [{ role: "user", content: "hello" }],
    })) {
      // Drain the stream.
    }

    expect(String(calls[0]?.input)).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    );
  });

  test("rejects malformed SSE JSON instead of silently dropping output", async () => {
    const provider = new OpenAICompatibleChatProvider(
      { apiKey: "test-key" },
      async () => new Response("data: {not-json}\n\n", { status: 200 }),
    );

    await expect(async () => {
      for await (const _chunk of provider.streamChat({
        messages: [{ role: "user", content: "hello" }],
      })) {
        // Drain the stream.
      }
    }).rejects.toThrow("malformed JSON");
  });

  test("rejects a truncated stream without a terminal marker", async () => {
    const provider = new OpenAICompatibleChatProvider(
      { apiKey: "test-key" },
      async () => new Response(
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        { status: 200 },
      ),
    );

    await expect(async () => {
      for await (const _chunk of provider.streamChat({
        messages: [{ role: "user", content: "hello" }],
      })) {
        // Drain the stream.
      }
    }).rejects.toThrow("without [DONE] or a terminal finish_reason");
  });

  test("surfaces terminal finish reasons", async () => {
    const provider = new OpenAICompatibleChatProvider(
      { apiKey: "test-key" },
      async () => new Response(
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        { status: 200 },
      ),
    );

    const chunks = [];
    for await (const chunk of provider.streamChat({
      messages: [{ role: "user", content: "hello" }],
    })) chunks.push(chunk);
    expect(chunks).toEqual([
      expect.objectContaining({ delta: "", finishReason: "length" }),
    ]);
  });
});
