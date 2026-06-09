import type { AgentEvent } from "@sunpilot/core";

export interface WebSocketLike {
  readyState: number;
}

export interface ConnectionState<TSocket extends WebSocketLike> {
  id: string;
  socket: TSocket;
  runSubscriptions: Set<string>;
  conversationSubscriptions: Set<string>;
}

/**
 * 连接注册表 — 管理活跃 WebSocket 连接及其事件订阅过滤器。
 */
export class ConnectionRegistry<TSocket extends WebSocketLike> {
  private readonly connections = new Map<TSocket, ConnectionState<TSocket>>();

  constructor(private readonly openReadyState = 1) {}

  add(
    socket: TSocket,
    id = `ws_${crypto.randomUUID()}`,
  ): ConnectionState<TSocket> {
    const state: ConnectionState<TSocket> = {
      id,
      socket,
      runSubscriptions: new Set(),
      conversationSubscriptions: new Set(),
    };
    this.connections.set(socket, state);
    return state;
  }

  remove(socket: TSocket): void {
    this.connections.delete(socket);
  }

  get(socket: TSocket): ConnectionState<TSocket> | undefined {
    return this.connections.get(socket);
  }

  clear(): void {
    this.connections.clear();
  }

  count(): number {
    return this.connections.size;
  }

  interestedSockets(
    event: Pick<AgentEvent, "runId" | "conversationId">,
  ): TSocket[] {
    return [...this.connections.values()]
      .filter((connection) => this.isInterested(connection, event))
      .map((connection) => connection.socket);
  }

  private isInterested(
    connection: ConnectionState<TSocket>,
    event: Pick<AgentEvent, "runId" | "conversationId">,
  ): boolean {
    if (connection.socket.readyState !== this.openReadyState) return false;
    if (event.runId && connection.runSubscriptions.has(event.runId)) return true;
    if (connection.runSubscriptions.has("*")) return true;
    return event.conversationId
      ? connection.conversationSubscriptions.has(event.conversationId)
      : false;
  }
}
