import type { ReactNode } from "react";
import { ConfigProvider } from "antd";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#2563eb",
          colorInfo: "#2563eb",
          colorSuccess: "#10b981",
          colorWarning: "#f59e0b",
          colorError: "#ef4444",

          colorBgLayout: "#f8fafc",
          colorBgContainer: "#ffffff",
          colorBorder: "#e5e7eb",
          colorText: "#111827",
          colorTextSecondary: "#6b7280",
          colorTextTertiary: "#9ca3af",

          borderRadius: 12,
          borderRadiusLG: 16,
          borderRadiusSM: 8,

          boxShadow: "0 18px 48px rgba(15, 23, 42, 0.08)",
          fontSize: 14,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Button: {
            borderRadius: 12,
            controlHeight: 40,
            fontWeight: 500,
          },
          Input: {
            borderRadius: 14,
            controlHeight: 40,
          },
          Card: {
            borderRadiusLG: 16,
            paddingLG: 16,
          },
          Menu: {
            itemBorderRadius: 8,
            itemSelectedBg: "#eef5ff",
            itemSelectedColor: "#1677ff",
            itemHoverBg: "#f4f8ff",
          },
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}
