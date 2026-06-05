import { AppShell } from "../../layouts/AppShell/AppShell";
import { SidebarNav } from "../../layouts/AppShell/SidebarNav";
import { EmptyStateIllustration } from "../../shared/components/illustrations";
import "./SettingsPage.scss";

export function SettingsPage() {
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
          <EmptyStateIllustration type="report" />
          <p className="section-kicker">设置</p>
          <h1>工作区设置</h1>
          <p>模型、连接、权限和个人偏好会在这里以专业 SaaS 表单呈现。</p>
        </section>
      </main>
    </AppShell>
  );
}
