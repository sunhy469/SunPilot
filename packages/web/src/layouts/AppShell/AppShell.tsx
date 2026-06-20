import type { ReactNode } from "react";
import { Layout } from "antd";
import "./AppShell.scss";

const { Content } = Layout;

export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <Layout className="app-shell" hasSider>
      {sidebar}
      <Layout>
        <Content className="app-main">{children}</Content>
      </Layout>
    </Layout>
  );
}
