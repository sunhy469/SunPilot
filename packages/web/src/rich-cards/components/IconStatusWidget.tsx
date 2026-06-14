import { memo } from "react";
import { Tag, Typography, Flex } from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  InfoCircleFilled,
  LoadingOutlined,
  SyncOutlined,
  MinusCircleFilled,
} from "@ant-design/icons";

const { Text } = Typography;

// ── Types ─────────────────────────────────────────────────────────────

export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";
export type ToolStatus = "running" | "completed" | "failed" | "pending";
export type SkillStatus = "running" | "completed" | "failed" | "pending";

export interface StatusBadgeProps {
  tone: StatusTone;
  label: string;
  icon?: boolean;
  size?: "small" | "default";
}

export interface ToolStatusBadgeProps {
  status: ToolStatus;
  toolName?: string;
  size?: "small" | "default";
}

export interface SkillStatusBadgeProps {
  status: SkillStatus;
  skillName?: string;
  size?: "small" | "default";
}

export interface InfoTipProps {
  message: string;
  tone?: StatusTone;
  icon?: boolean;
}

// ── Tone config ───────────────────────────────────────────────────────

const TONE_COLORS: Record<StatusTone, string> = {
  success: "#10b981",
  warning: "#f59e0b",
  error: "#ef4444",
  info: "#2563eb",
  neutral: "#6b7280",
};

const TONE_ICONS: Record<StatusTone, React.ReactNode> = {
  success: <CheckCircleFilled style={{ color: "#10b981" }} />,
  warning: <ExclamationCircleFilled style={{ color: "#f59e0b" }} />,
  error: <CloseCircleFilled style={{ color: "#ef4444" }} />,
  info: <InfoCircleFilled style={{ color: "#2563eb" }} />,
  neutral: <MinusCircleFilled style={{ color: "#6b7280" }} />,
};

const TOOL_STATUS_CONFIG: Record<
  ToolStatus,
  { tone: StatusTone; label: string; icon: React.ReactNode }
> = {
  running: {
    tone: "info",
    label: "运行中",
    icon: <LoadingOutlined style={{ color: "#2563eb" }} spin />,
  },
  completed: {
    tone: "success",
    label: "已完成",
    icon: <CheckCircleFilled style={{ color: "#10b981" }} />,
  },
  failed: {
    tone: "error",
    label: "失败",
    icon: <CloseCircleFilled style={{ color: "#ef4444" }} />,
  },
  pending: {
    tone: "neutral",
    label: "等待中",
    icon: <SyncOutlined style={{ color: "#6b7280" }} />,
  },
};

const SKILL_STATUS_CONFIG: Record<
  SkillStatus,
  { tone: StatusTone; label: string; icon: React.ReactNode }
> = {
  running: {
    tone: "info",
    label: "执行中",
    icon: <LoadingOutlined style={{ color: "#2563eb" }} spin />,
  },
  completed: {
    tone: "success",
    label: "执行成功",
    icon: <CheckCircleFilled style={{ color: "#10b981" }} />,
  },
  failed: {
    tone: "error",
    label: "执行失败",
    icon: <CloseCircleFilled style={{ color: "#ef4444" }} />,
  },
  pending: {
    tone: "neutral",
    label: "等待执行",
    icon: <SyncOutlined style={{ color: "#6b7280" }} />,
  },
};

// ── StatusBadge ───────────────────────────────────────────────────────

export const StatusBadge = memo(function StatusBadge({
  tone,
  label,
  icon = true,
  size = "default",
}: StatusBadgeProps) {
  const color = TONE_COLORS[tone];
  return (
    <Tag
      color={color}
      icon={icon ? TONE_ICONS[tone] : undefined}
      className={`status-badge status-badge--${tone} status-badge--${size}`}
      style={{
        borderColor: color,
        color: tone === "neutral" ? "#374151" : color,
        background: `${color}10`,
      }}
    >
      {label}
    </Tag>
  );
});

// ── ToolStatusBadge ───────────────────────────────────────────────────

export const ToolStatusBadge = memo(function ToolStatusBadge({
  status,
  toolName,
  size = "default",
}: ToolStatusBadgeProps) {
  const config = TOOL_STATUS_CONFIG[status];
  return (
    <Flex align="center" gap={8} className={`tool-status tool-status--${size}`}>
      <Tag
        color={TONE_COLORS[config.tone]}
        icon={config.icon}
        style={{
          borderColor: TONE_COLORS[config.tone],
          color: TONE_COLORS[config.tone],
          background: `${TONE_COLORS[config.tone]}10`,
        }}
      >
        {config.label}
      </Tag>
      {toolName && (
        <Text className="tool-status__name">{toolName}</Text>
      )}
    </Flex>
  );
});

// ── SkillStatusBadge ──────────────────────────────────────────────────

export const SkillStatusBadge = memo(function SkillStatusBadge({
  status,
  skillName,
  size = "default",
}: SkillStatusBadgeProps) {
  const config = SKILL_STATUS_CONFIG[status];
  return (
    <Flex align="center" gap={8} className={`skill-status skill-status--${size}`}>
      <Tag
        color={TONE_COLORS[config.tone]}
        icon={config.icon}
        style={{
          borderColor: TONE_COLORS[config.tone],
          color: TONE_COLORS[config.tone],
          background: `${TONE_COLORS[config.tone]}10`,
        }}
      >
        {config.label}
      </Tag>
      {skillName && (
        <Text className="skill-status__name">{skillName}</Text>
      )}
    </Flex>
  );
});

// ── InfoTip ───────────────────────────────────────────────────────────

export const InfoTip = memo(function InfoTip({
  message,
  tone = "info",
  icon = true,
}: InfoTipProps) {
  return (
    <Flex
      align="center"
      gap={6}
      className={`info-tip info-tip--${tone}`}
      style={{
        padding: "6px 12px",
        borderRadius: 8,
        background: `${TONE_COLORS[tone]}0D`,
        border: `1px solid ${TONE_COLORS[tone]}30`,
      }}
    >
      {icon && TONE_ICONS[tone]}
      <Text
        style={{
          fontSize: 13,
          color: tone === "neutral" ? "#374151" : TONE_COLORS[tone],
        }}
      >
        {message}
      </Text>
    </Flex>
  );
});

// ── Re-export as unified IconStatusWidget namespace ──────────────────
export const IconStatusWidget = {
  StatusBadge,
  ToolStatusBadge,
  SkillStatusBadge,
  InfoTip,
};

export default IconStatusWidget;
