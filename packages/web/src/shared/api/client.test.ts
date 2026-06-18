import { afterEach, describe, expect, test, vi } from "vitest";
import { createRequest } from "./client";

describe("createRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("does not send JSON content-type for bodyless requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await createRequest()<{ ok: boolean }>("/v1/conversations/conv_1", {
      method: "DELETE",
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
  });

  test("adds JSON content-type when a body is present", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await createRequest()<{ ok: boolean }>("/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "New Chat" }),
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });
});
