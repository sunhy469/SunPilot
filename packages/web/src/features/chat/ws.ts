import type { ChatSendParams } from "./types";

export function createChatSocket(): WebSocket {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${location.host}/v1/ws`);
}

export function chatSocketUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/v1/ws`;
}

export function sendChatMessage(socket: WebSocket, params: ChatSendParams) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "chat.send", params }));
}

export function sendChatStop(socket: WebSocket) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "chat.stop", params: {} }));
}
