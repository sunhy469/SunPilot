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
import { RunDebugPanel } from "../../features/agent-runtime/RunDebugPanel";
import { SettingsPage } from "../SettingsPage";
import { conversationTitle } from "../../features/conversations/model";
import "./ChatPage.scss";

export function ChatPage() {
  const [activePanel, setActivePanel] = useState<"chat" | "automation" | "plugins" | "debug" | "settings">("chat");
  const request = useMemo(() => createRequest(), []);
  const conversations = useConversations(request, true);
  const chat = useChat(
    conversations.activeConversationId,
    conversations.setActiveConversationId,
    conversations.setMessages,
    (conversationId: string) => {
      void conversations.addConversationById(conversationId);
    },
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
            conversations.newChat();
            chat.preconnect();
          }}
          onSelect={(id) => {
            setActivePanel("chat");
            void conversations.selectConversation(id);
          }}
          onOpenAutomation={() => setActivePanel("automation")}
          onOpenPlugins={() => setActivePanel("plugins")}
          onOpenDebug={() => setActivePanel("debug")}
          onOpenSettings={() => setActivePanel("settings")}
          onRename={(id, title) => { void conversations.renameConversation(id, title); }}
          onDeleteConversation={(id) => conversations.deleteConversation(id)}
          onTogglePin={(id, pinned) => { void conversations.togglePin(id, pinned); }}
        />
      }
    >
      <div className="chat-page">
        <ChatHeader
          title={
            activePanel === "automation"
              ? "自动化"
              : activePanel === "plugins"
                ? "插件"
                : activePanel === "debug"
                  ? "Run Debug"
                  : activePanel === "settings"
                    ? "Settings"
                  : active
                    ? conversationTitle(active.title)
                    : ""
          }
        />

        {activePanel === "automation" ? (
          <div className="chat-page" />
        ) : activePanel === "plugins" ? (
          <PluginsEmptyView />
        ) : activePanel === "settings" ? (
          <SettingsPage />
        ) : activePanel === "debug" ? (
          <div className="chat-page" style={{ overflow: "hidden" }}>
            <RunDebugPanel
              runId={chat.activeRunId}
              conversationId={conversations.activeConversationId}
            />
          </div>
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
                  sendState={chat.sendState}
                  toolName={chat.toolName}
                  onCardAction={chat.onCardAction}
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
                    disabled={chat.pending}
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
