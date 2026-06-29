import { describe, expect, test } from "vitest";
import { ZodError } from "zod";
import { parseAgentChatRequest } from "./agent.schema.js";

describe("parseAgentChatRequest", () => {
  test("uses the canonical chat schema and preserves attachment-only input", () => {
    expect(parseAgentChatRequest({
      message: "",
      attachments: [{
        id: "att_1",
        name: "image.png",
        type: "image/png",
        url: "https://example.com/image.png",
      }],
    })).toEqual({
      conversationId: undefined,
      message: "",
      attachments: [{
        id: "att_1",
        name: "image.png",
        type: "image/png",
        url: "https://example.com/image.png",
      }],
    });
  });

  test("returns a typed validation error for an empty request", () => {
    expect(() => parseAgentChatRequest({ message: "", attachments: [] })).toThrow(ZodError);
  });
});
