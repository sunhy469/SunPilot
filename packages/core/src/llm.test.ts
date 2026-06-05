import { describe, expect, test } from "vitest";
import { createDefaultLlmProvider, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, OpenAICompatibleChatProvider } from "./llm.js";

describe("OpenAICompatibleChatProvider", () => {
  test("uses DeepSeek defaults and streams OpenAI-compatible chat deltas", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const provider = new OpenAICompatibleChatProvider({ apiKey: "test-key" }, async (input, init) => {
      calls.push({ input, init });
      return new Response(
        [
          'data: {"id":"chatcmpl_1","model":"deepseek-v4-flash","choices":[{"delta":{"role":"assistant","content":"he"}}]}',
          "",
          'data: {"id":"chatcmpl_1","model":"deepseek-v4-flash","choices":[{"delta":{"content":"llo"}}]}',
          "",
          "data: [DONE]",
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    });

    const deltas: string[] = [];
    for await (const chunk of provider.streamChat({ messages: [{ role: "user", content: "hello" }], maxTokens: 16 })) {
      deltas.push(chunk.delta);
    }

    expect(deltas).toEqual(["he", "llo"]);
    expect(String(calls[0]?.input)).toBe(`${DEFAULT_LLM_BASE_URL}/chat/completions`);
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      model: DEFAULT_LLM_MODEL,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
      stream: true
    });
  });

  test("creates the default provider from SunPilot env values", async () => {
    const provider = createDefaultLlmProvider({
      SUNPILOT_LLM_API_KEY: "env-key",
      SUNPILOT_LLM_BASE_URL: "https://example.test/v1",
      SUNPILOT_LLM_MODEL: "custom-model"
    });

    expect(provider.model).toBe("custom-model");
  });

  test("allows DEEPSEEK_API_KEY as a fallback secret name", () => {
    const provider = createDefaultLlmProvider({ DEEPSEEK_API_KEY: "deepseek-key" });

    expect(provider.model).toBe(DEFAULT_LLM_MODEL);
  });

  test("does not create a provider without an API key", () => {
    expect(() => createDefaultLlmProvider({})).toThrow("SUNPILOT_LLM_API_KEY or DEEPSEEK_API_KEY is required.");
  });
});
