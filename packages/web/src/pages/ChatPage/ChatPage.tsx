import { Alert, Button, Input } from "antd";
import { useMemo, useState } from "react";
import { createRequest, setStoredToken } from "../../shared/api/client";
import { AppLayout } from "../../shared/components/AppLayout";
import { ErrorState } from "../../shared/components/ErrorState";
import { AgentStatusBar } from "./components/AgentStatusBar";
import { ChatInput } from "./components/ChatInput";
import { ChatSidebar } from "./components/ChatSidebar";
import { ChatThread } from "./components/ChatThread";
import { useChat } from "./hooks/useChat";
import { useConversations } from "./hooks/useConversations";
import "./ChatPage.scss";

export function ChatPage({ initialToken }: { initialToken: string }) {
  const [token, setToken] = useState(initialToken);
  const [tokenInput, setTokenInput] = useState(initialToken);
  const request = useMemo(() => createRequest(token), [token]);
  const enabled = Boolean(token);
  const conversations = useConversations(request, enabled);
  const chat = useChat(token, conversations.activeConversationId, conversations.setActiveConversationId, conversations.setMessages);
  const active = conversations.conversations.find((item) => item.id === conversations.activeConversationId);

  if (!enabled) {
    return (
      <main className="auth-shell">
        <form
          className="auth-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const next = tokenInput.trim();
            if (!next) return;
            setStoredToken(next);
            setToken(next);
          }}
        >
          <Input.Password aria-label="Token" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} />
          <Button aria-label="Connect" type="primary" htmlType="submit" block />
        </form>
      </main>
    );
  }

  return (
    <AppLayout
      sidebar={
        <ChatSidebar
          conversations={conversations.conversations}
          activeConversationId={conversations.activeConversationId}
          onNewChat={() => void conversations.newChat()}
          onSelect={(id) => void conversations.selectConversation(id)}
        />
      }
    >
      <main className="chat-page">
        <header className="chat-page__topbar">
          <div className="chat-page__title">
            <h1>{active?.title ?? "New Chat"}</h1>
            <span>{conversations.activeConversationId}</span>
          </div>
          <AgentStatusBar status={chat.status} />
        </header>
        {chat.error && <ErrorState message={chat.error} />}
        {!conversations.activeConversationId && <Alert type="info" showIcon title="New Chat" />}
        <ChatThread messages={conversations.messages} />
        <ChatInput disabled={chat.pending} onSend={chat.send} />
      </main>
    </AppLayout>
  );
}
