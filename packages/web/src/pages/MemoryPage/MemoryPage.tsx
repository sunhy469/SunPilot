import { AppShell } from "../../layouts/AppShell/AppShell";
import { SidebarNav } from "../../layouts/AppShell/SidebarNav";
import { EmptyStateIllustration } from "../../shared/components/illustrations";
import "./MemoryPage.scss";

export function MemoryPage() {
  return (
    <AppShell
      sidebar={
        <aside className="section-sidebar">
          <div className="section-sidebar__logo">SP</div>
          <SidebarNav activeConversationId="" />
        </aside>
      }
    >
      <main className="section-page">
        <section className="section-empty">
          <EmptyStateIllustration type="memory" />
          <p className="section-kicker">记忆</p>
          <h1>上下文记忆</h1>
          <p>关键偏好、项目事实和长期上下文会在这里保持清晰可控。</p>
        </section>
      </main>
    </AppShell>
  );
}
