import { useMemo, useState } from "react";
import { createRequest } from "../../shared/api/client";
import { AppShell } from "../../layouts/AppShell/AppShell";
import { Sidebar } from "../../layouts/AppShell/Sidebar";
import { useChat } from "./hooks/useChat";
import { useConversations } from "./hooks/useConversations";
import { ChatHeader } from "./components/ChatHeader";
import { WelcomeView } from "./components/WelcomeView";
import { MessageList } from "./components/MessageList";
import { ChatComposer } from "./components/ChatComposer";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { ApprovalStrip } from "./components/ApprovalStrip";
import { OfflineBanner } from "./components/OfflineBanner";
import { ErrorMessageCard } from "./components/ErrorMessageCard";
import { PluginsEmptyView } from "./components/PluginsEmptyView";
import { conversationTitle } from "../../features/conversations/model";
import "./ChatPage.scss";

export function ChatPage() {
  const [activePanel, setActivePanel] = useState<"chat" | "plugins">("chat");
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
          activePanel={activePanel}
          onNewChat={() => {
            setActivePanel("chat");
            void conversations.newChat();
          }}
          onSelect={(id) => {
            setActivePanel("chat");
            void conversations.selectConversation(id);
          }}
          onOpenPlugins={() => setActivePanel("plugins")}
        />
      }
    >
      <div className="chat-page">
        <ChatHeader
          title={
            activePanel === "plugins"
              ? "插件"
              : active
                ? conversationTitle(active.title)
                : ""
          }
        />

        {activePanel === "plugins" ? (
          <PluginsEmptyView />
        ) : (
          <>
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
                  <ArtifactPanel
                    artifacts={chat.artifacts}
                    selected={chat.selectedArtifact}
                    onOpen={chat.openArtifact}
                    onClose={chat.closeArtifact}
                  />
                  <ApprovalStrip
                    approvals={chat.approvals}
                    onApprove={chat.approveApproval}
                    onReject={chat.rejectApproval}
                  />
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
                    sendState={chat.sendState}
                    onSendStateChange={chat.setSendState}
                    onSend={chat.send}
                    onStop={chat.stop}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
