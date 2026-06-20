import { memo, useState } from "react";
import { Card, Typography, Flex, Button, Tag, Steps } from "antd";
import {
  ThunderboltOutlined,
  DownOutlined,
  UpOutlined,
} from "@ant-design/icons";
import type { SkillStatus } from "./IconStatusWidget";
import { SkillStatusBadge } from "./IconStatusWidget";
import type { RichTextValue } from "../types";
import { RichTextRenderer } from "../richText";

const { Text, Paragraph } = Typography;

// ── Types ─────────────────────────────────────────────────────────────

export interface SkillStep {
  title: string;
  description?: string;
  status: "done" | "active" | "pending" | "error";
}

export interface SkillResultWidgetProps {
  /** Skill name */
  skillName: string;
  /** Skill execution status */
  status: SkillStatus;
  /** Skill ID */
  skillId?: string;
  /** Execution steps */
  steps?: SkillStep[];
  /** Step count (when steps array is not available) */
  stepCount?: number;
  /** Summary of results */
  summary?: string;
  /** Detailed output */
  detail?: string;
  /** Error message if failed */
  error?: string;
  /** Duration in ms */
  durationMs?: number;
  /** Timestamp */
  timestamp?: string;
  /** Card title */
  title?: RichTextValue;
}

// ── Component ─────────────────────────────────────────────────────────

export const SkillResultWidget = memo(function SkillResultWidget({
  skillName,
  status,
  skillId,
  steps,
  stepCount,
  summary,
  detail,
  error,
  durationMs,
  timestamp,
  title,
}: SkillResultWidgetProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = detail || error;

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

  return (
    <Card
      title={
        title ? <RichTextRenderer value={title} inline={true} /> : (
          <Flex align="center" gap={8}>
            <ThunderboltOutlined style={{ color: "#8b5cf6" }} />
            <Text strong>Skill 执行</Text>
          </Flex>
        )
      }
      size="small"
      className="skill-result-card"
      styles={{
        header: {
          borderBottom: `1px solid ${borderColor}`,
        },
      }}
    >
      <Flex vertical gap={8}>
        {/* Header row */}
        <Flex align="center" justify="space-between" wrap="wrap" gap={8}>
          <Flex align="center" gap={8}>
            <Text strong className="skill-result__name">
              {skillName}
            </Text>
            <SkillStatusBadge status={status} />
          </Flex>
          <Flex gap={8} align="center">
            {skillId && (
              <Text
                type="secondary"
                style={{ fontSize: 11, fontFamily: "monospace" }}
              >
                {skillId.slice(0, 8)}...
              </Text>
            )}
            {durationMs != null && (
              <Tag>{durationMs}ms</Tag>
            )}
          </Flex>
        </Flex>

        {/* Steps */}
        {stepCount != null && (!steps || steps.length === 0) && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {stepCount} 个步骤
          </Text>
        )}
        {steps && steps.length > 0 && (
          <div className="skill-result__steps">
            <Steps
              direction="vertical"
              size="small"
              current={steps.findIndex((s) => s.status !== "done")}
              items={steps.map((step) => ({
                title: step.title,
                description: step.description,
                status:
                  step.status === "error"
                    ? "error"
                    : step.status === "done"
                      ? "finish"
                      : step.status === "active"
                        ? "process"
                        : "wait",
              }))}
            />
          </div>
        )}

        {/* Summary */}
        {summary && (
          <Paragraph
            style={{ margin: 0, fontSize: 13 }}
            className="skill-result__summary"
          >
            {summary}
          </Paragraph>
        )}

        {/* Error */}
        {error && (
          <div className="skill-result__error">
            <Text style={{ color: "#dc2626", fontSize: 13 }}>{error}</Text>
          </div>
        )}

        {/* Expandable detail */}
        {hasDetail && (
          <div className="skill-result__details">
            <Button
              type="text"
              size="small"
              icon={expanded ? <UpOutlined /> : <DownOutlined />}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "收起详情" : "查看详情"}
            </Button>
            {expanded && (
              <pre className="skill-result__detail-pre">{detail || error}</pre>
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
