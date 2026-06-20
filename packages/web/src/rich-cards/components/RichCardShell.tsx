import type { ReactNode } from "react";
import { Card, Typography } from "antd";
import type { RichTextValue } from "../types";
import { RichTextRenderer } from "../richText";

const { Text } = Typography;

export function RichCardShell({
  title,
  subtitle,
  className = "",
  children,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  className?: string;
  children: ReactNode;
}) {
  const titleNode = title != null ? <RichTextRenderer value={title} /> : undefined;
  const subtitleNode = subtitle != null ? (
    <Text type="secondary" style={{ display: "block", marginBottom: 12, marginTop: -4 }}>
      <RichTextRenderer value={subtitle} />
    </Text>
  ) : null;

  return (
    <Card
      className={`rich-card ${className}`.trim()}
      title={titleNode}
      size="small"
      styles={{
        header: subtitle ? { paddingBottom: 0 } : undefined,
      }}
    >
      {subtitleNode}
      {children}
    </Card>
  );
}
