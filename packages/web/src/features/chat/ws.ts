import type { ChatSendParams } from "./types";

export function createChatSocket(token: string): WebSocket {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${location.host}/v1/ws?token=${encodeURIComponent(token)}`);
}

export function sendChatMessage(socket: WebSocket, params: ChatSendParams) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "chat.send", params }));
}
