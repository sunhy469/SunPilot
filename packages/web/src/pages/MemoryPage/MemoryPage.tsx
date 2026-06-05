import { AppLayout } from "../../shared/components/AppLayout";
import "./MemoryPage.scss";

export function MemoryPage() {
  return (
    <AppLayout sidebar={<aside className="section-sidebar"><strong>SunPilot</strong></aside>}>
      <main className="section-page">
        <h1>Memory</h1>
      </main>
    </AppLayout>
  );
}
