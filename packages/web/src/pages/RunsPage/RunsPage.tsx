import { AppShell } from "../../layouts/AppShell/AppShell";
import { SidebarNav } from "../../layouts/AppShell/SidebarNav";
import { EmptyStateIllustration } from "../../shared/components/illustrations";
import "./RunsPage.scss";

export function RunsPage() {
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
          <EmptyStateIllustration type="project" />
          <p className="section-kicker">项目</p>
          <h1>项目运行工作台</h1>
          <p>后续会在这里展示任务运行、项目分析和 Agent 执行状态。</p>
        </section>
      </main>
    </AppShell>
  );
}
