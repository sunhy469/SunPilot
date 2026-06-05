import { AppLayout } from "../../shared/components/AppLayout";
import "./SettingsPage.scss";

export function SettingsPage() {
  return (
    <AppLayout sidebar={<aside className="section-sidebar"><strong>SunPilot</strong></aside>}>
      <main className="section-page">
        <h1>Settings</h1>
      </main>
    </AppLayout>
  );
}
