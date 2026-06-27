import type { ChatMessage } from "../../../features/conversations/types";

function closeEnough(a: string, b: string, thresholdMs: number): boolean {
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  return Number.isFinite(aTime) &&
    Number.isFinite(bTime) &&
    Math.abs(aTime - bTime) < thresholdMs;
}

function findServerMatchForOptimisticUser(
  local: ChatMessage,
  serverMessages: ChatMessage[],
  usedServerIds: Set<string>,
): ChatMessage | undefined {
  if (local.role !== "user" || !local.id.startsWith("local_")) return undefined;
  return serverMessages.find(
    (server) =>
      server.role === "user" &&
      !usedServerIds.has(server.id) &&
      local.content === server.content &&
      closeEnough(local.createdAt, server.createdAt, 30_000),
  );
}

/**
 * Reconcile persisted history with optimistic/live messages.
 *
 * Persisted `/messages` order is canonical. Local messages are appended only
 * when the server has not persisted or acknowledged them yet, preventing
 * assistant-only event state from grouping ahead of user history.
 */
export function mergeMessagesById(
  localMessages: ChatMessage[],
  serverMessages: ChatMessage[],
): ChatMessage[] {
  const serverIds = new Set(serverMessages.map((message) => message.id));
  const matchedServerUserIds = new Set<string>();
  const matchedLocalIds = new Set<string>();

  for (const local of localMessages) {
    if (serverIds.has(local.id)) continue;
    const match = findServerMatchForOptimisticUser(
      local,
      serverMessages,
      matchedServerUserIds,
    );
    if (match) {
      matchedLocalIds.add(local.id);
      matchedServerUserIds.add(match.id);
    }
  }

  const unpersistedLocal = localMessages.filter(
    (local) => !serverIds.has(local.id) && !matchedLocalIds.has(local.id),
  );

  return [...serverMessages, ...unpersistedLocal];
}
