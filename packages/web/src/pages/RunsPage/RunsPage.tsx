import { AppLayout } from "../../shared/components/AppLayout";
import "./RunsPage.scss";

export function RunsPage() {
  return (
    <AppLayout sidebar={<aside className="section-sidebar"><strong>SunPilot</strong></aside>}>
      <main className="section-page">
        <h1>Runs</h1>
      </main>
    </AppLayout>
  );
}
