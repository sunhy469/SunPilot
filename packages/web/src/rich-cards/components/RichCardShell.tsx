import type { ReactNode } from "react";
import { Card, Typography } from "antd";

const { Text } = Typography;

export function RichCardShell({
  title,
  subtitle,
  className = "",
  children,
}: {
  title?: string;
  subtitle?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card
      className={`rich-card ${className}`.trim()}
      title={title || undefined}
      size="small"
      styles={{
        header: subtitle ? { paddingBottom: 0 } : undefined,
      }}
    >
      {subtitle && (
        <Text type="secondary" style={{ display: "block", marginBottom: 12, marginTop: -4 }}>
          {subtitle}
        </Text>
      )}
      {children}
    </Card>
  );
}
