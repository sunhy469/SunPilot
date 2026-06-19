import type { ChatSendParams, ChatStopParams } from "./types";

export function createChatSocket(): WebSocket {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${location.host}/v1/ws`);
}

export function chatSocketUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/v1/ws`;
}

/**
 * 通过 WebSocket 发送 chat.send JSON-RPC 命令。
 *
 * 数据流向：
 * ChatComposer → sendChatMessage → WebSocket → daemon JsonRpcRouter → AgentService.handleChatCommand
 *
 * 返回的流式事件通过 WebSocket 的 onmessage 回调接收（JSON-RPC notification 格式）。
 *
 * @returns The JSON-RPC request id, used to match the ack response.
 */
export function sendChatMessage(socket: WebSocket, params: ChatSendParams): string {
  const id = crypto.randomUUID();
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "chat.send",
      params: {
        conversationId: params.conversationId,
        message: params.message,
        mode: params.mode ?? "agent",
        permissionMode: params.permissionMode ?? "auto",
        modelId: params.modelId,
        clientRequestId: params.clientRequestId,
        attachments: params.attachments,
      },
    }),
  );
  return id;
}

export function sendChatStop(socket: WebSocket, params: ChatStopParams) {
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "chat.stop",
      params: { runId: params.runId },
    }),
  );
}
