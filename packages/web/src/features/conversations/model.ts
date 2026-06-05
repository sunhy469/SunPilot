export function conversationTitle(title: string | undefined) {
  return title?.trim() || "New Chat";
}
