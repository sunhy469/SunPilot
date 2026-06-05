import type { ReactNode } from "react";
import "./AppShell.css";

export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="app-shell">
      <div className="app-frame">
        {sidebar}
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}
