import { AppShell } from "../../layouts/AppShell/AppShell";
import { SidebarNav } from "../../layouts/AppShell/SidebarNav";
import { EmptyStateIllustration } from "../../shared/components/illustrations";
import "./ArtifactsPage.scss";

export function ArtifactsPage() {
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
          <EmptyStateIllustration type="knowledge" />
          <p className="section-kicker">知识库</p>
          <h1>知识与产物</h1>
          <p>结构化文档、检索结果和生成内容会以轻量卡片在这里沉淀。</p>
        </section>
      </main>
    </AppShell>
  );
}
