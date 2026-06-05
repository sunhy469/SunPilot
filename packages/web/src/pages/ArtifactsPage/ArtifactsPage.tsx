import { AppLayout } from "../../shared/components/AppLayout";
import "./ArtifactsPage.scss";

export function ArtifactsPage() {
  return (
    <AppLayout sidebar={<aside className="section-sidebar"><strong>SunPilot</strong></aside>}>
      <main className="section-page">
        <h1>Artifacts</h1>
      </main>
    </AppLayout>
  );
}
