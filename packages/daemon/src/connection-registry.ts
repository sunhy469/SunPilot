import type { SunPilotEvent } from "@sunpilot/protocol";

export interface WebSocketLike {
  readyState: number;
}

export interface ConnectionState<TSocket extends WebSocketLike> {
  id: string;
  socket: TSocket;
  runSubscriptions: Set<string>;
  conversationSubscriptions: Set<string>;
}

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
    event: Pick<SunPilotEvent, "runId" | "conversationId">,
  ): TSocket[] {
    return [...this.connections.values()]
      .filter((connection) => this.isInterested(connection, event))
      .map((connection) => connection.socket);
  }

  private isInterested(
    connection: ConnectionState<TSocket>,
    event: Pick<SunPilotEvent, "runId" | "conversationId">,
  ): boolean {
    if (connection.socket.readyState !== this.openReadyState) return false;
    if (connection.runSubscriptions.has(event.runId)) return true;
    if (connection.runSubscriptions.has("*")) return true;
    return event.conversationId
      ? connection.conversationSubscriptions.has(event.conversationId)
      : false;
  }
}
