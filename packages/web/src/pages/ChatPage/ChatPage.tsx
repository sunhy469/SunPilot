import { lazy, Suspense, useMemo, useState } from "react";
import { createRequest } from "../../shared/api/client";
import { AppShell } from "../../layouts/AppShell/AppShell";
import { Sidebar } from "../../layouts/AppShell/Sidebar";
import { useChat } from "./hooks/useChat";
import { useConversations } from "./hooks/useConversations";
import { ChatHeader } from "./components/ChatHeader/ChatHeader";
import { WelcomeView } from "./components/WelcomeView/WelcomeView";
import { MessageList } from "./components/MessageList/MessageList";
import { ChatComposer } from "./components/ChatComposer/ChatComposer";
import { ArtifactPanel } from "./components/ArtifactPanel/ArtifactPanel";
import { ApprovalStrip } from "./components/ApprovalStrip/ApprovalStrip";
import { OfflineBanner } from "./components/OfflineBanner/OfflineBanner";
import { ErrorMessageCard } from "./components/ErrorMessageCard/ErrorMessageCard";
import { PluginsEmptyView } from "./components/PluginsEmptyView/PluginsEmptyView";
import { RunDebugPanel } from "../../features/agent-runtime/RunDebugPanel";
import { conversationTitle } from "../../features/conversations/model";
import { collectAiOutputs } from "./utils/collectAiOutputs";
import "./ChatPage.scss";

// Route-level lazy chunks: DigitalWorld pulls in PixiJS (~300KB), SettingsPage
// pulls in code editor + form libs. Both are conditionally-rendered panels, so
// splitting them shrinks the initial bundle by ~600KB and lets the chat UI
// render while the heavy chunks stream in.
const DigitalWorld = lazy(() =>
  import("../../features/digital-world").then((m) => ({ default: m.DigitalWorld })),
);
const SettingsPage = lazy(() =>
  import("../SettingsPage").then((m) => ({ default: m.SettingsPage })),
);

const PanelFallback = () => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
    <span style={{ color: "#888" }}>加载中…</span>
  </div>
);

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
  // Only show welcome when there's no active conversation AND no messages.
  // During conversation switching, messages are cleared immediately but
  // activeConversationId is set — we show the chat area (not welcome) so
  // messages load in without a jarring welcome → chat flash.
  const isWelcome =
    !hasMessages &&
    !conversations.activeConversationId &&
    chat.chatViewState !== "loadingConversation";
  const isOffline = chat.chatViewState === "offline";

  const aiOutputs = useMemo(
    () => collectAiOutputs(conversations.messages),
    [conversations.messages],
  );

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
            chat.preconnect();
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
      <div className={activePanel === "automation" ? "chat-page chat-page--digital-world" : "chat-page"}>
        {activePanel !== "automation" && (
          <ChatHeader
          title={
            activePanel === "plugins"
              ? "插件"
              : activePanel === "debug"
                ? "Run Debug"
                : activePanel === "settings"
                  ? "Settings"
                  : active
                    ? conversationTitle(active.title)
                    : ""
          }
          conversation={activePanel === "chat" ? active : undefined}
          showConversationActions={activePanel === "chat" && !!active}
          onRename={(id, title) => { void conversations.renameConversation(id, title); }}
          onTogglePin={(id, pinned) => { void conversations.togglePin(id, pinned); }}
          outputCount={aiOutputs.length}
          outputs={aiOutputs}
        />
        )}

        {activePanel === "automation" ? (
          <Suspense fallback={<PanelFallback />}>
            <DigitalWorld />
          </Suspense>
        ) : activePanel === "plugins" ? (
          <PluginsEmptyView />
        ) : activePanel === "settings" ? (
          <Suspense fallback={<PanelFallback />}>
            <SettingsPage />
          </Suspense>
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
                  loadingMessages={conversations.loadingMessages}
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
