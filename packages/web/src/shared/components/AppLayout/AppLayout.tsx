import type { ReactNode } from "react";
import { Layout } from "antd";
import "./AppLayout.scss";

export function AppLayout({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <Layout className="app-layout">
      <Layout.Sider className="app-layout__sidebar" width={300} breakpoint="lg" collapsedWidth={0}>
        {sidebar}
      </Layout.Sider>
      <Layout.Content className="app-layout__content">{children}</Layout.Content>
    </Layout>
  );
}
