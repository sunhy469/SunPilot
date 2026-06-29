import { afterEach, describe, expect, test, vi } from "vitest";
import { createRequest } from "./client";

describe("createRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
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

  test("adds the launcher-provided local bearer token", async () => {
    const token = "b".repeat(64);
    window.location.hash = `sunpilot-token=${token}`;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await createRequest()<{ ok: boolean }>("/v1/config");

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(window.location.hash).toBe("");
  });
});
