import { memo, useState } from "react";
import { Card, Typography, Flex, Button, Tag, Collapse } from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  SyncOutlined,
  DownOutlined,
  UpOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { ToolStatus } from "./IconStatusWidget";
import { ToolStatusBadge } from "./IconStatusWidget";
import type { RichTextValue } from "../types";
import { RichTextRenderer } from "../richText";

const { Text, Paragraph } = Typography;

// ── Types ─────────────────────────────────────────────────────────────

export interface ToolResultWidgetProps {
  /** Tool name */
  toolName: string;
  /** Tool execution status */
  status: ToolStatus;
  /** Tool call ID for reference */
  toolCallId?: string;
  /** Summary of the result */
  summary?: string;
  /** Detailed output (shown in collapsible section) */
  detail?: string;
  /** Any artifacts produced */
  artifacts?: string[];
  /** Error message if failed */
  error?: string;
  /** Duration in ms */
  durationMs?: number;
  /** Timestamp of execution */
  timestamp?: string;
  /** Card title override */
  title?: RichTextValue;
}

// ── Component ─────────────────────────────────────────────────────────

export const ToolResultWidget = memo(function ToolResultWidget({
  toolName,
  status,
  toolCallId,
  summary,
  detail,
  artifacts,
  error,
  durationMs,
  timestamp,
  title,
}: ToolResultWidgetProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = detail || artifacts?.length || error;

  const borderColor = (() => {
    switch (status) {
      case "completed":
        return "#10b98130";
      case "failed":
        return "#ef444430";
      case "running":
        return "#2563eb30";
      case "pending":
        return "#e5e7eb";
    }
  })();

  const bgColor = (() => {
    switch (status) {
      case "completed":
        return "#f0fdf4";
      case "failed":
        return "#fef2f2";
      case "running":
        return "#eff6ff";
      case "pending":
        return "#f9fafb";
    }
  })();

  return (
    <Card
      title={
        title ? <RichTextRenderer value={title} inline={true} /> : (
          <Flex align="center" gap={8}>
            <ToolOutlined />
            <Text strong>工具调用</Text>
          </Flex>
        )
      }
      size="small"
      className="tool-result-card"
      styles={{
        header: {
          borderBottom: `1px solid ${borderColor}`,
        },
        body: {
          background: bgColor,
        },
      }}
    >
      <Flex vertical gap={8}>
        {/* Header row */}
        <Flex align="center" justify="space-between" wrap="wrap" gap={8}>
          <Flex align="center" gap={8}>
            <Text strong className="tool-result__name">
              {toolName}
            </Text>
            <ToolStatusBadge status={status} />
          </Flex>
          <Flex gap={8} align="center">
            {toolCallId && (
              <Text type="secondary" style={{ fontSize: 11, fontFamily: "monospace" }}>
                {toolCallId.slice(0, 8)}...
              </Text>
            )}
            {durationMs != null && (
              <Tag>{durationMs}ms</Tag>
            )}
          </Flex>
        </Flex>

        {/* Summary */}
        {summary && (
          <Paragraph
            style={{ margin: 0, fontSize: 13 }}
            className="tool-result__summary"
          >
            {summary}
          </Paragraph>
        )}

        {/* Error */}
        {error && (
          <div className="tool-result__error">
            <Flex align="flex-start" gap={6}>
              <CloseCircleFilled style={{ color: "#ef4444", marginTop: 3 }} />
              <Text style={{ color: "#dc2626", fontSize: 13 }}>{error}</Text>
            </Flex>
          </div>
        )}

        {/* Expandable details */}
        {hasDetail && (
          <div className="tool-result__details">
            <Button
              type="text"
              size="small"
              icon={expanded ? <UpOutlined /> : <DownOutlined />}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "收起详情" : "查看详情"}
            </Button>
            {expanded && (
              <div className="tool-result__detail-content">
                {detail && (
                  <pre className="tool-result__detail-pre">{detail}</pre>
                )}
                {artifacts && artifacts.length > 0 && (
                  <div className="tool-result__artifacts">
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      产物:
                    </Text>
                    <Flex gap={4} wrap="wrap">
                      {artifacts.map((a) => (
                        <Tag key={a}>{a}</Tag>
                      ))}
                    </Flex>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Timestamp */}
        {timestamp && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {new Date(timestamp).toLocaleTimeString()}
          </Text>
        )}
      </Flex>
    </Card>
  );
});

export default ToolResultWidget;
