import { describe, expect, test } from "vitest";
import {
  ConnectionRegistry,
  type WebSocketLike,
} from "./connection-registry.js";
import {
  subscribeEventStreamer,
  type RuntimeEventSource,
} from "./event-streamer.js";

interface SocketStub extends WebSocketLike {
  name: string;
}

function socket(name: string, readyState = 1): SocketStub {
  return { name, readyState };
}

describe("ConnectionRegistry", () => {
  test("matches open sockets by run and conversation subscriptions", () => {
    const registry = new ConnectionRegistry<SocketStub>(1);
    const byRun = socket("run");
    const byConversation = socket("conversation");
    const wildcard = socket("wildcard");
    const closed = socket("closed", 3);

    registry.add(byRun).runSubscriptions.add("run_1");
    registry.add(byConversation).conversationSubscriptions.add("conv_1");
    registry.add(wildcard).runSubscriptions.add("*");
    registry.add(closed).runSubscriptions.add("run_1");

    expect(
      registry.interestedSockets({ runId: "run_1", conversationId: "conv_1" }),
    ).toEqual([byRun, byConversation, wildcard]);
  });

  test("removes and clears connection state", () => {
    const registry = new ConnectionRegistry<SocketStub>(1);
    const one = socket("one");
    const two = socket("two");
    registry.add(one).runSubscriptions.add("run_1");
    registry.add(two).runSubscriptions.add("run_1");

    registry.remove(one);
    expect(registry.interestedSockets({ runId: "run_1" })).toEqual([two]);

    registry.clear();
    expect(registry.interestedSockets({ runId: "run_1" })).toEqual([]);
  });
});

describe("subscribeEventStreamer", () => {
  test("sends canonical notifications only to interested sockets", () => {
    const registry = new ConnectionRegistry<SocketStub>(1);
    const interested = socket("interested");
    const ignored = socket("ignored");
    registry.add(interested).conversationSubscriptions.add("conv_1");
    registry.add(ignored).conversationSubscriptions.add("conv_other");
    const sent: Array<{ socket: string; notification: unknown }> = [];
    let listener:
      | Parameters<RuntimeEventSource["subscribeEvents"]>[0]
      | undefined;
    const unsubscribe = subscribeEventStreamer({
      runtimeStore: {
        subscribeEvents(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      registry,
      send(socket, notification) {
        sent.push({ socket: socket.name, notification });
      },
    });

    listener?.({
      id: "evt_1",
      runId: "run_1",
      conversationId: "conv_1",
      type: "agent.run.completed",
      payload: { runId: "run_1", artifacts: [], toolCalls: 0 },
      createdAt: "2026-06-06T00:00:00.000Z",
    });

    expect(sent).toEqual([
      {
        socket: "interested",
        notification: expect.objectContaining({
          jsonrpc: "2.0",
          method: "agent.run.completed",
          params: expect.objectContaining({ eventId: "evt_1" }),
        }),
      },
    ]);

    unsubscribe();
    expect(listener).toBeUndefined();
  });
});
