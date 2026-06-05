import { useMemo } from "react";
import { createRequest } from "../../shared/api/client";
import { AppShell } from "../../layouts/AppShell/AppShell";
import { Sidebar } from "../../layouts/AppShell/Sidebar";
import { useChat } from "./hooks/useChat";
import { useConversations } from "./hooks/useConversations";
import { ChatHeader } from "./components/ChatHeader";
import { WelcomeView } from "./components/WelcomeView";
import { MessageList } from "./components/MessageList";
import { ChatComposer } from "./components/ChatComposer";
import { OfflineBanner } from "./components/OfflineBanner";
import { ErrorMessageCard } from "./components/ErrorMessageCard";
import { conversationTitle } from "../../features/conversations/model";
import "./ChatPage.scss";

export function ChatPage() {
  const request = useMemo(() => createRequest(), []);
  const conversations = useConversations(request, true);
  const chat = useChat(
    conversations.activeConversationId,
    conversations.setActiveConversationId,
    conversations.setMessages,
  );

  const active = conversations.conversations.find(
    (item) => item.id === conversations.activeConversationId,
  );

  const hasMessages = conversations.messages.length > 0;
  const isWelcome =
    !hasMessages && chat.chatViewState !== "loadingConversation";
  const isOffline = chat.chatViewState === "offline";

  return (
    <AppShell
      sidebar={
        <Sidebar
          conversations={conversations.conversations}
          activeConversationId={conversations.activeConversationId}
          onNewChat={() => void conversations.newChat()}
          onSelect={(id) => void conversations.selectConversation(id)}
        />
      }
    >
      <div className="chat-page">
        <ChatHeader
          title={active ? conversationTitle(active.title) : "新对话"}
        />

        {isOffline && !hasMessages && <OfflineBanner />}

        {chat.error && isWelcome && (
          <div className="chat-page__error-wrap">
            <ErrorMessageCard
              message={chat.error}
              onRetry={() => {
                chat.setError("");
              }}
            />
          </div>
        )}

        {isWelcome ? (
          <WelcomeView onSend={chat.send} disabled={chat.pending} />
        ) : (
          <>
            <MessageList
              messages={conversations.messages}
              status={chat.chatViewState}
            />
            <div className="chat-composer-wrap">
              {isOffline && <OfflineBanner />}
              {chat.error && (
                <div className="chat-page__error-wrap">
                  <ErrorMessageCard
                    message={chat.error}
                    onRetry={() => chat.setError("")}
                  />
                </div>
              )}
              <ChatComposer
                placeholder="向 SunPilot 继续提问..."
                disabled={false}
                streaming={chat.chatViewState === "streaming"}
                onSend={chat.send}
                onStop={chat.stop}
              />
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
