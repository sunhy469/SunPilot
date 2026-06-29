import { afterEach, describe, expect, test } from "vitest";
import { getLocalToken, withLocalTokenQuery } from "./local-token";

const TOKEN = "a".repeat(64);

describe("local daemon token bootstrap", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  test("moves a fragment token into tab storage and removes it from the URL", () => {
    window.location.hash = `sunpilot-token=${TOKEN}`;
    expect(getLocalToken()).toBe(TOKEN);
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem("sunpilot.localToken")).toBe(TOKEN);
  });

  test("adds the stored token to WebSocket URLs", () => {
    window.sessionStorage.setItem("sunpilot.localToken", TOKEN);
    expect(withLocalTokenQuery("ws://localhost/v1/ws")).toBe(
      `ws://localhost/v1/ws?token=${TOKEN}`,
    );
  });

  test("rejects malformed fragment values", () => {
    window.location.hash = "sunpilot-token=short";
    expect(getLocalToken()).toBeUndefined();
  });
});
