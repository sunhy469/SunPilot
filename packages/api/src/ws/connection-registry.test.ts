import { describe, expect, test } from "vitest";
import { ConnectionRegistry, type WebSocketLike } from "./connection-registry.js";

function mockSocket(overrides: Partial<WebSocketLike> = {}): WebSocketLike {
  return {
    readyState: 1,
    once: undefined,
    ...overrides,
  };
}

describe("ConnectionRegistry", () => {
  test("add registers a connection and assigns an id", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    const socket = mockSocket();
    const state = registry.add(socket);
    expect(state.id).toMatch(/^ws_/);
    expect(state.socket).toBe(socket);
    expect(registry.count()).toBe(1);
  });

  test("add accepts a custom id", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    const state = registry.add(mockSocket(), "custom_id");
    expect(state.id).toBe("custom_id");
  });

  test("remove deletes a connection", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    const socket = mockSocket();
    registry.add(socket);
    expect(registry.count()).toBe(1);
    registry.remove(socket);
    expect(registry.count()).toBe(0);
  });

  test("get returns the connection state", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    const socket = mockSocket();
    const added = registry.add(socket);
    expect(registry.get(socket)).toBe(added);
    expect(registry.get(mockSocket())).toBeUndefined();
  });

  test("clear removes all connections", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    registry.add(mockSocket());
    registry.add(mockSocket());
    expect(registry.count()).toBe(2);
    registry.clear();
    expect(registry.count()).toBe(0);
  });

  test("interestedSockets returns sockets subscribed to the runId", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    const subbed = mockSocket();
    const unsubbed = mockSocket();
    registry.add(subbed).runSubscriptions.add("run_1");
    registry.add(unsubbed);
    const interested = registry.interestedSockets({ runId: "run_1" });
    expect(interested).toEqual([subbed]);
  });

  test("interestedSockets returns sockets with wildcard subscription", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    const wildcard = mockSocket();
    registry.add(wildcard).runSubscriptions.add("*");
    const interested = registry.interestedSockets({ runId: "run_anything" });
    expect(interested).toEqual([wildcard]);
  });

  test("interestedSockets returns sockets subscribed to conversationId", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    const convSocket = mockSocket();
    registry.add(convSocket).conversationSubscriptions.add("conv_1");
    const interested = registry.interestedSockets({ conversationId: "conv_1" });
    expect(interested).toEqual([convSocket]);
  });

  test("interestedSockets skips closed sockets", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    const closed = mockSocket({ readyState: 3 });
    registry.add(closed).runSubscriptions.add("run_1");
    expect(registry.interestedSockets({ runId: "run_1" })).toEqual([]);
  });

  test("interestedSockets returns empty when no subscriptions match", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    registry.add(mockSocket());
    expect(
      registry.interestedSockets({ runId: "run_1", conversationId: "conv_1" }),
    ).toEqual([]);
  });

  test("interestedSockets handles event with neither runId nor conversationId", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    registry.add(mockSocket());
    expect(registry.interestedSockets({})).toEqual([]);
  });

  test("auto-removes connection when socket emits close event", () => {
    const registry = new ConnectionRegistry<WebSocketLike>();
    let closeHandler: (() => void) | undefined;
    const socket: WebSocketLike = {
      readyState: 1,
      once: (_event: "close", listener: () => void) => {
        closeHandler = listener;
      },
    };
    registry.add(socket);
    expect(registry.count()).toBe(1);
    closeHandler?.();
    expect(registry.count()).toBe(0);
  });
});
