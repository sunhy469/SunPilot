import type { ChatMessage as ChatMessageType } from "../../../features/conversations/types";
import { EmptyState } from "../../../shared/components/EmptyState";
import { ChatMessage } from "./ChatMessage";

export function ChatThread({ messages }: { messages: ChatMessageType[] }) {
  return (
    <section className="chat-thread">
      {messages.length === 0 ? <EmptyState /> : messages.map((message) => <ChatMessage key={message.id} message={message} />)}
    </section>
  );
}
