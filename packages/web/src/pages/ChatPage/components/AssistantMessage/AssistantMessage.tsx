import { useState, useCallback, useRef, useEffect } from "react";
import { Flex, Button, Typography, message, Alert, Card, Tag } from "antd";
import {
  CopyOutlined,
  LikeOutlined,
  LikeFilled,
  DislikeOutlined,
  DislikeFilled,
  LoadingOutlined,
  ToolOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  CaretRightOutlined,
  CaretDownOutlined,
  RightOutlined,
  DownOutlined,
} from "@ant-design/icons";
import type { AgentActivity } from "../../../../features/conversations/types";
import type {
  ChatMessage,
  AssistantMessagePart,
  AssistantTextPart,
  AssistantStatusPart,
  AssistantToolUsePart,
  AssistantToolResultPart,
  AssistantErrorPart,
} from "../../../../features/conversations/types";
import {
  buildThinkingSteps,
  buildUserFacingBlocks,
  type ThinkingStep,
  type ToolStep,
} from "../../utils/buildAssistantPresentation";
import type { RichCardAction } from "../../../../rich-cards/types";
import { MarkdownRenderer, RichCardRenderer } from "../../../../rich-cards";
import type { LocalSendState } from "../../types";
import { formatTime } from "../../../../shared/utils/formatTime";
import { TypingDots } from "../TypingDots/TypingDots";
import "./AssistantMessage.scss";

const { Text } = Typography;

// ── Product content renderer (Rich Card + Streamdown) ───────────────

function ProductContentRenderer({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  // 无论流式中还是完成后，都优先渲染完整 Markdown，由 Streamdown 处理
  if (!content.trim()) return null;

  return (
    <div className="assistant-markdown-wrap">
      <MarkdownRenderer content={content} isStreaming={isStreaming} />
    </div>
  );
}

// ── AI status mapping ───────────────────────────────────────────────

function getAiStatus(
  sendState?: LocalSendState,
  toolName?: string,
): { icon: React.ReactNode; text: string; dots?: boolean } | null {
  switch (sendState) {
    case "sending":
      return {
        icon: (
          <LoadingOutlined className="assistant-status__icon assistant-loading-icon" />
        ),
        text: "正在连接 SunPilot...",
      };
    case "accepted":
      return {
        icon: (
          <LoadingOutlined className="assistant-status__icon assistant-loading-icon" />
        ),
        text: "已接收，正在创建运行...",
      };
    case "running":
      if (toolName) {
        return { icon: <ToolOutlined />, text: `正在调用工具: ${toolName}` };
      }
      return {
        icon: (
          <LoadingOutlined className="assistant-status__icon assistant-loading-icon" />
        ),
        text: "准备中...",
      };
    case "streaming":
      if (toolName) {
        return { icon: <ToolOutlined />, text: `正在调用工具: ${toolName}` };
      }
      return {
        icon: <ThunderboltOutlined className="thinking-section__active-icon" />,
        text: "正在推理...",
        dots: true,
      };
    case "waiting_approval":
      return {
        icon: <ToolOutlined />,
        text: "等待你确认工具调用",
      };
    case "waiting_user":
      return {
        icon: <ThunderboltOutlined />,
        text: "等待你补充信息",
      };
    default:
      return null;
  }
}

// ── Legacy activity list ────────────────────────────────────────────

function getActivityIcon(activity: AgentActivity) {
  if (activity.status === "failed") return <CloseCircleOutlined />;
  if (activity.status === "completed") return <CheckCircleOutlined />;
  if (activity.kind === "tool") return <ToolOutlined />;
  if (activity.kind === "model") return <ThunderboltOutlined />;
  return <LoadingOutlined className="assistant-activity__icon" />;
}

function AgentActivityList({ activities }: { activities?: AgentActivity[] }) {
  if (!activities || activities.length === 0) return null;

  return (
    <Flex vertical gap={6} className="assistant-activity-list">
      {activities.map((activity) => (
        <Flex
          key={activity.id}
          align="start"
          gap={8}
          className={`assistant-activity assistant-activity--${activity.status ?? "running"}`}
        >
          {getActivityIcon(activity)}
          <Flex vertical>
            <Text className="assistant-activity__label">{activity.label}</Text>
            {activity.detail && (
              <Text type="secondary" className="assistant-activity__detail">
                {activity.detail}
              </Text>
            )}
          </Flex>
        </Flex>
      ))}
    </Flex>
  );
}

// ── Thinking text block (lightweight rendering inside ThinkingProcessSection) ──

function ThinkingTextBlock({
  part,
  isStreaming,
}: {
  part: AssistantTextPart;
  isStreaming: boolean;
}) {
  if (!part.content) return null;
  return (
    <div className="thinking-text-block">
      <MarkdownRenderer content={part.content} isStreaming={isStreaming} />
    </div>
  );
}

// ── Content-block parts rendering ───────────────────────────────────

function TextPartBlock({
  part,
  isStreaming,
}: {
  part: AssistantTextPart;
  isStreaming: boolean;
}) {
  if (!part.content && !isStreaming) return null;
  return (
    <ProductContentRenderer content={part.content} isStreaming={isStreaming} />
  );
}

function StatusPartBlock({ part }: { part: AssistantStatusPart }) {
  const isRunning = part.status === "running";
  const isFailed = part.status === "failed";

  const className = [
    "assistant-status-block",
    `assistant-status-block--${part.status}`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Flex align="center" gap={6} className={className}>
      {isRunning ? (
        <LoadingOutlined className="assistant-status-block__icon assistant-loading-icon" />
      ) : isFailed ? (
        <CloseCircleOutlined className="assistant-status-block__icon" />
      ) : (
        <CheckCircleOutlined className="assistant-status-block__icon" />
      )}
      <Text type="secondary" className="assistant-status-block__label">
        {part.label}
      </Text>
      {part.metadata?.progress != null && isRunning && (
        <Text type="secondary" className="assistant-status-block__progress">
          {part.metadata.progress}%
        </Text>
      )}
    </Flex>
  );
}

/** §P0: Hide full base64 dataUrls in tool arg display.
 *  Replaces `data:image/png;base64,iVBOR...` with `[base64 image, image/png, N KB]`. */
const DATA_URL_RE = /^data:([^;]+);base64,[A-Za-z0-9+/=]+$/;
function formatArgValue(value: string): string {
  const m = DATA_URL_RE.exec(value);
  if (m) {
    const mime = m[1]!;
    const bytes = Math.round((value.length * 3) / 4);
    const kb = Math.max(1, Math.round(bytes / 1024));
    return `[base64 image, ${mime}, ${kb}KB]`;
  }
  return value;
}

function ToolUsePartBlock({ part }: { part: AssistantToolUsePart }) {
  const [expanded, setExpanded] = useState(false);
  const hasPreview =
    part.inputPreview && Object.keys(part.inputPreview).length > 0;

  const isRunning = part.status === "running" || part.status === "pending";
  const isCompleted = part.status === "completed";
  const isFailed = part.status === "failed";

  const statusClass = isRunning
    ? "assistant-tool-use--running"
    : isCompleted
      ? "assistant-tool-use--completed"
      : isFailed
        ? "assistant-tool-use--failed"
        : "";

  // 根据状态选择图标
  const statusIcon = isRunning ? (
    <LoadingOutlined className="assistant-tool-use__icon assistant-loading-icon" />
  ) : isCompleted ? (
    <CheckCircleOutlined className="assistant-tool-use__icon" />
  ) : isFailed ? (
    <CloseCircleOutlined className="assistant-tool-use__icon" />
  ) : (
    <ToolOutlined className="assistant-tool-use__icon" />
  );

  return (
    <Flex vertical className={`assistant-tool-use ${statusClass}`}>
      <Flex
        align="center"
        gap={4}
        className="assistant-tool-use__header"
        onClick={() => hasPreview && setExpanded(!expanded)}
      >
        {hasPreview &&
          (expanded ? <CaretDownOutlined /> : <CaretRightOutlined />)}
        {statusIcon}
        <Text type="secondary" className="assistant-tool-use__name">
          {part.name}
        </Text>
      </Flex>
      {expanded && hasPreview && (
        <Card size="small" className="assistant-tool-use__args">
          {Object.entries(part.inputPreview!).map(([key, value]) => (
            <Flex key={key} gap={4} className="assistant-tool-use__arg">
              <Text type="secondary" className="assistant-tool-use__arg-key">
                {key}:
              </Text>{" "}
              <Text className="assistant-tool-use__arg-value">
                {formatArgValue(String(value))}
              </Text>
            </Flex>
          ))}
        </Card>
      )}
    </Flex>
  );
}

function ToolResultPartBlock({ part }: { part: AssistantToolResultPart }) {
  const [expanded, setExpanded] = useState(false);
  const icon =
    part.trust === "untrusted" ? (
      <ExclamationCircleOutlined />
    ) : (
      <CheckCircleOutlined />
    );

  return (
    <Flex vertical className="assistant-tool-result">
      <Flex
        align="center"
        gap={4}
        className="assistant-tool-result__header assistant-status-block--clickable"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
        {icon}
        <Text
          type="secondary"
          ellipsis={{ tooltip: part.summary }}
          className="assistant-tool-result__summary"
        >
          {part.summary}
        </Text>
      </Flex>
      {expanded && (
        <Card size="small" className="assistant-tool-result__detail">
          <Text type="secondary">{part.summary}</Text>
        </Card>
      )}
    </Flex>
  );
}

function ErrorPartBlock({ part }: { part: AssistantErrorPart }) {
  // §P2: step_detail errors are merged into tool steps via buildThinkingSteps.
  // Only render fatal errors (scope="run" or presentation="fatal") as standalone cards.
  // For backward compat: recoverable errors without explicit scope are suppressed
  // (they belong to tool steps); non-recoverable errors are treated as fatal.
  const isStepDetail =
    part.presentation === "step_detail" ||
    part.scope === "tool" ||
    part.scope === "protocol";
  if (isStepDetail) return null;

  // §P2 backward compat: recoverable errors without explicit scope → step_detail
  if (part.recoverable && !part.scope && !part.presentation) return null;

  return (
    <Alert
      type="error"
      showIcon
      icon={<CloseCircleOutlined />}
      message={part.message}
      className="assistant-error-alert"
      style={{ margin: "4px 0", borderRadius: 6 }}
    />
  );
}

// ── Unified thinking banner (no parts yet, or edge-case fallback) ────
//
// When the agent is still preparing (no structured parts have arrived),
// this banner provides the same visual language as ThinkingProcessSection:
// collapsible container, blue lightning icon, "正在思考" label, and
// animated dots. It replaces the old bare assistant-status bars so every
// in-progress state looks consistent.

function UnifiedThinkingBanner({
  isActive,
  statusText,
}: {
  isActive: boolean;
  statusText?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Auto-collapse when the phase ends (content has arrived).
  useEffect(() => {
    if (!isActive) {
      setCollapsed(true);
    }
  }, [isActive]);

  if (collapsed) {
    return (
      <Flex
        align="center"
        gap={6}
        className="thinking-section thinking-section--collapsed"
        onClick={() => setCollapsed(false)}
      >
        <RightOutlined className="thinking-section__arrow" />
        {isActive ? (
          <ThunderboltOutlined className="thinking-section__active-icon" />
        ) : (
          <CheckCircleOutlined className="thinking-section__icon" />
        )}
        <Text type="secondary" className="thinking-section__summary">
          思考过程
        </Text>
      </Flex>
    );
  }

  return (
    <Flex vertical gap={6} className="thinking-section">
      <Flex
        align="center"
        gap={6}
        className="thinking-section__header"
        onClick={() => setCollapsed(true)}
      >
        <DownOutlined className="thinking-section__arrow" />
        <ThunderboltOutlined className="thinking-section__active-icon" />
        <Text type="secondary" className="thinking-section__title">
          正在思考
        </Text>
        {isActive && <TypingDots />}
      </Flex>
      {statusText && (
        <div className="thinking-section__content">
          <Flex align="center" gap={6}>
            <ThunderboltOutlined
              style={{ fontSize: 12, color: "var(--sp-blue)", opacity: 0.8 }}
            />
            <Text type="secondary" style={{ fontSize: 13 }}>
              {statusText}
            </Text>
          </Flex>
        </div>
      )}
    </Flex>
  );
}

// ── Thinking step renderer (single logical step in the collapse bar) ─

function ThinkingStepRenderer({ step }: { step: ThinkingStep }) {
  const [detailExpanded, setDetailExpanded] = useState(false);

  if (step.kind === "narrative") {
    return (
      <div className="thinking-text-block">
        <MarkdownRenderer content={step.content} isStreaming={false} />
      </div>
    );
  }

  if (step.kind === "phase") {
    const isRunning = step.status === "running";
    const isFailed = step.status === "failed";
    return (
      <Flex align="center" gap={6} className="assistant-status-block">
        {isRunning ? (
          <LoadingOutlined className="assistant-status-block__icon assistant-loading-icon" />
        ) : isFailed ? (
          <CloseCircleOutlined className="assistant-status-block__icon" />
        ) : (
          <CheckCircleOutlined className="assistant-status-block__icon" />
        )}
        <Text type="secondary" className="assistant-status-block__label">
          {step.label}
        </Text>
      </Flex>
    );
  }

  // Tool step
  const stepLabel = getToolStepLabel(step);
  const isRunning = step.status === "running";
  const isCompleted = step.status === "completed";
  const isFailed = step.status === "failed";
  const hasDetail = !!(
    step.inputPreview ||
    step.resultSummary ||
    step.errorDetail
  );

  const statusIcon = isRunning ? (
    <LoadingOutlined className="assistant-tool-use__icon assistant-loading-icon" />
  ) : isCompleted ? (
    <CheckCircleOutlined className="assistant-tool-use__icon" />
  ) : isFailed ? (
    <CloseCircleOutlined className="assistant-tool-use__icon" />
  ) : (
    <ToolOutlined className="assistant-tool-use__icon" />
  );

  const statusClass = isRunning
    ? "assistant-tool-use--running"
    : isCompleted
      ? "assistant-tool-use--completed"
      : isFailed
        ? "assistant-tool-use--failed"
        : "";

  return (
    <Flex vertical className={`assistant-tool-use ${statusClass}`}>
      <Flex
        align="center"
        gap={4}
        className="assistant-tool-use__header"
        onClick={() => hasDetail && setDetailExpanded(!detailExpanded)}
        style={{ cursor: hasDetail ? "pointer" : "default" }}
      >
        {hasDetail &&
          (detailExpanded ? <CaretDownOutlined /> : <CaretRightOutlined />)}
        {statusIcon}
        <Text type="secondary" className="assistant-tool-use__name">
          {stepLabel}
        </Text>
      </Flex>
      {detailExpanded && hasDetail && (
        <Card size="small" className="assistant-tool-use__args">
          {step.inputPreview &&
            Object.entries(step.inputPreview).map(([key, value]) => (
              <Flex key={key} gap={4} className="assistant-tool-use__arg">
                <Text type="secondary" className="assistant-tool-use__arg-key">
                  {key}:
                </Text>{" "}
                <Text className="assistant-tool-use__arg-value">
                  {formatArgValue(String(value))}
                </Text>
              </Flex>
            ))}
          {step.resultSummary && (
            <Flex gap={4} className="assistant-tool-use__arg">
              <Text type="secondary" className="assistant-tool-use__arg-key">
                结果:
              </Text>{" "}
              <Text
                type="secondary"
                className="assistant-tool-use__arg-value"
                style={{ whiteSpace: "normal" }}
              >
                {step.resultSummary}
              </Text>
            </Flex>
          )}
          {step.errorDetail && (
            <Flex gap={4} className="assistant-tool-use__arg">
              <Text
                type="danger"
                className="assistant-tool-use__arg-value"
                style={{ whiteSpace: "normal" }}
              >
                {step.errorDetail}
              </Text>
            </Flex>
          )}
        </Card>
      )}
    </Flex>
  );
}

/** Map tool step status to user-facing label following the design spec. */
function getToolStepLabel(step: ToolStep): string {
  switch (step.status) {
    case "running":
      return `正在${step.name}…`;
    case "completed":
      return `已${step.name}`;
    case "failed":
      return `${step.name}失败`;
    case "interrupted":
      return `${step.name}已中断`;
    default:
      return step.name;
  }
}

// ── Thinking process section (collapsible) ──────────────────────────

function ThinkingProcessSection({
  steps,
  isStreaming,
}: {
  steps: ThinkingStep[];
  isStreaming: boolean;
}) {
  // §P1-1: Default expanded during streaming so users see progress immediately.
  // Auto-collapses when streaming completes (final text has appeared).
  const [collapsed, setCollapsed] = useState(false);

  // Auto-collapse when the message is complete (final answer visible)
  useEffect(() => {
    if (!isStreaming) {
      setCollapsed(true);
    }
  }, [isStreaming]);

  if (steps.length === 0) return null;

  const stepCount = steps.length;

  // §Dynamic title: show "闪电 + 正在思考 + ..." during streaming,
  // plain "思考过程" when complete and expanded.
  const titleNode = isStreaming ? (
    <>
      <ThunderboltOutlined className="thinking-section__active-icon" />
      <Text type="secondary" className="thinking-section__title">
        正在思考
      </Text>
      <TypingDots />
    </>
  ) : (
    <Text type="secondary" className="thinking-section__title">
      思考过程
    </Text>
  );

  if (collapsed) {
    return (
      <Flex
        align="center"
        gap={6}
        className="thinking-section thinking-section--collapsed"
        onClick={() => setCollapsed(false)}
      >
        <RightOutlined className="thinking-section__arrow" />
        {isStreaming ? (
          <ThunderboltOutlined className="thinking-section__active-icon" />
        ) : (
          <CheckCircleOutlined className="thinking-section__icon" />
        )}
        <Text type="secondary" className="thinking-section__summary">
          思考过程 ({stepCount} 步)
        </Text>
      </Flex>
    );
  }

  return (
    <Flex vertical gap={6} className="thinking-section">
      <Flex
        align="center"
        gap={6}
        className="thinking-section__header"
        onClick={() => setCollapsed(true)}
      >
        <DownOutlined className="thinking-section__arrow" />
        {titleNode}
      </Flex>
      <Flex vertical gap={4} className="thinking-section__content">
        {steps.map((step) => (
          <ThinkingStepRenderer key={step.key} step={step} />
        ))}
      </Flex>
    </Flex>
  );
}

// ── Part renderer ───────────────────────────────────────────────────

function PartRenderer({
  part,
  isStreaming,
  variant = "default",
}: {
  part: AssistantMessagePart;
  isStreaming: boolean;
  variant?: "default" | "thinking";
}) {
  switch (part.type) {
    case "text":
      return variant === "thinking" ? (
        <ThinkingTextBlock part={part} isStreaming={isStreaming} />
      ) : (
        <TextPartBlock part={part} isStreaming={isStreaming} />
      );
    case "status":
      return <StatusPartBlock part={part} />;
    case "tool_use":
      return <ToolUsePartBlock part={part} />;
    case "tool_result":
      return <ToolResultPartBlock part={part} />;
    case "error":
      return <ErrorPartBlock part={part} />;
    default:
      return null;
  }
}

// ── Message parts renderer (with thinking/product split) ────────────

function MessagePartsRenderer({
  parts,
  isStreaming,
}: {
  parts?: AssistantMessagePart[];
  isStreaming: boolean;
}) {
  if (!parts || parts.length === 0) return null;
  const normalizedParts = normalizeCompletedParts(parts, isStreaming);

  // §P0-1: Use explicit semanticRole when available.
  // - "progress" → thinking section (pre-tool reasoning)
  // - "final"   → product section (final answer)
  // - "user_prompt" → product section (user-facing prompt during waiting_user)
  // When NO text part has semanticRole set, fall back to the legacy
  // last-text-is-final rule for backward compatibility with old data.
  const hasSemanticRoles = normalizedParts.some(
    (p) => p.type === "text" && (p as { semanticRole?: string }).semanticRole,
  );

  if (hasSemanticRoles) {
    // §P1: New path — use builder functions for clean logical grouping
    const thinkingSteps = buildThinkingSteps(normalizedParts);
    const userFacingBlocks = buildUserFacingBlocks(normalizedParts, {
      includeStreamingProgress: isStreaming,
    });
    const userFacingPartIds = new Set(
      userFacingBlocks.map((block) => block.partId),
    );
    const productParts = normalizedParts.filter((part) =>
      userFacingPartIds.has(part.id),
    );
    const hasVisiblePresentation =
      thinkingSteps.length > 0 || productParts.length > 0;

    return (
      <Flex vertical gap={8} className="assistant-parts">
        {hasVisiblePresentation ? (
          <ThinkingProcessSection steps={thinkingSteps} isStreaming={isStreaming} />
        ) : (
          isStreaming && (
            <UnifiedThinkingBanner isActive={true} statusText="正在分析..." />
          )
        )}
        {productParts.map((part) => (
          <PartRenderer
            key={part.id}
            part={part}
            isStreaming={
              isStreaming && part.type === "text" && part.status === "streaming"
            }
          />
        ))}
      </Flex>
    );
  }

  // Legacy fallback for messages without semanticRole
  let lastTextIdx = -1;
  for (let i = normalizedParts.length - 1; i >= 0; i--) {
    if (normalizedParts[i]!.type === "text") {
      lastTextIdx = i;
      break;
    }
  }

  const thinkingParts: AssistantMessagePart[] = [];
  const productParts: AssistantMessagePart[] = [];

  for (let i = 0; i < normalizedParts.length; i++) {
    const part = normalizedParts[i]!;
    if (part.type === "error") {
      // §P2: For legacy errors, filter by recoverable
      const errorPart = part as AssistantErrorPart;
      if (!errorPart.recoverable || errorPart.scope === "run" || errorPart.presentation === "fatal") {
        productParts.push(part);
      }
      // recoverable errors without scope go to thinking (will be merged by builder)
      // but for legacy path we still show them in thinking section
      thinkingParts.push(part);
    } else if (part.type === "text") {
      if (i === lastTextIdx) {
        productParts.push(part);
      } else {
        thinkingParts.push(part);
      }
    } else {
      thinkingParts.push(part);
    }
  }

  // For legacy path, build thinking steps from the thinking parts
  const legacyThinkingSteps = buildThinkingSteps(thinkingParts);
  const visibleProductParts = productParts.filter(
    (part) => part.type !== "text" || part.content.length > 0,
  );
  const hasVisiblePresentation =
    legacyThinkingSteps.length > 0 || visibleProductParts.length > 0;

  return (
    <Flex vertical gap={8} className="assistant-parts">
      {hasVisiblePresentation ? (
        <ThinkingProcessSection steps={legacyThinkingSteps} isStreaming={isStreaming} />
      ) : (
        isStreaming && (
          <UnifiedThinkingBanner isActive={true} statusText="正在分析..." />
        )
      )}
      {visibleProductParts.map((part) => (
        <PartRenderer
          key={part.id}
          part={part}
          isStreaming={
            isStreaming && part.type === "text" && part.status === "streaming"
          }
        />
      ))}
    </Flex>
  );
}

function normalizeCompletedParts(
  parts: AssistantMessagePart[],
  isStreaming: boolean,
): AssistantMessagePart[] {
  if (isStreaming) return parts;
  const completedAt = new Date().toISOString();
  return parts.map((part) => {
    if (part.type === "status" && part.status === "running") {
      return {
        ...part,
        status: "completed",
        completedAt: part.completedAt ?? completedAt,
        metadata: {
          ...part.metadata,
          phase: "completed",
        },
      };
    }
    if (
      part.type === "tool_use" &&
      (part.status === "pending" || part.status === "running")
    ) {
      return {
        ...part,
        status: "completed",
      };
    }
    if (part.type === "text" && part.status === "streaming") {
      return {
        ...part,
        status: "completed",
        completedAt: part.completedAt ?? completedAt,
      };
    }
    return part;
  });
}

// ── Main AssistantMessage component ─────────────────────────────────

export function AssistantMessage({
  message: msg,
  isStreaming,
  cards,
  cardStateByCardId,
  sendState,
  toolName,
  onCardAction,
}: {
  message: ChatMessage;
  isStreaming?: boolean;
  cards?: ChatMessage["cards"];
  cardStateByCardId?: ChatMessage["cardStateByCardId"];
  sendState?: LocalSendState;
  toolName?: string;
  onCardAction?: (action: RichCardAction) => void;
}) {
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const likedRef = useRef(liked);
  const dislikedRef = useRef(disliked);
  likedRef.current = liked;
  dislikedRef.current = disliked;
  const hasContent = msg.content.length > 0;
  const hasParts = msg.parts && msg.parts.length > 0;
  const isPending = msg.status === "pending";
  const isStopped = msg.status === "stopped";
  const aiStatus = getAiStatus(sendState, toolName);

  const handleCopy = useCallback(() => {
    const text = msg.content;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => message.success("已复制到剪贴板"))
        .catch(() => {});
    }
  }, [msg.content]);

  const handleLike = useCallback(() => {
    if (dislikedRef.current) setDisliked(false);
    setLiked((v) => !v);
  }, []);

  const handleDislike = useCallback(() => {
    if (likedRef.current) setLiked(false);
    setDisliked((v) => !v);
  }, []);

  return (
    <Flex className="message-row assistant">
      <Flex vertical className="assistant-content">
        {/* ── Content-block parts rendering ────────── */}
        {hasParts ? (
          <MessagePartsRenderer parts={msg.parts} isStreaming={!!isStreaming} />
        ) : (
          <>
            {/* ── Stopped state indicator ─────────────── */}
            {isStopped && (
              <div className="assistant-status__tag--stopped">
                <Tag icon={<ExclamationCircleOutlined />} color="warning">
                  已停止生成
                </Tag>
              </div>
            )}

            {/* ── Unified thinking banner (before content) ────── */}
            {/* Replaces scattered aiStatus bars / TypingDots with a single
                collapsible section matching ThinkingProcessSection visually. */}
            {!hasContent && !isStopped && (isPending || isStreaming || aiStatus) && (
              <UnifiedThinkingBanner
                isActive={isPending || isStreaming || !!aiStatus}
                statusText={aiStatus?.text}
              />
            )}

            {/* ── Text content ─────────────────────────────────── */}
            <div className="assistant-text">
              {hasContent && (
                <ProductContentRenderer
                  content={msg.content}
                  isStreaming={!!isStreaming}
                />
              )}
            </div>
          </>
        )}

        {/* ── Rich cards (video, image, etc.) ─────────────────── */}
        {cards && cards.length > 0 && <RichCardRenderer cards={cards} stateByCardId={cardStateByCardId} onAction={onCardAction} />}

        {/* ── Action row ─────────────────────────────────────── */}
        {!isStreaming && hasContent && (
          <Flex align="center" gap={4} className="assistant-actions">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={handleCopy}
            />
            <Button
              type="text"
              size="small"
              icon={liked ? <LikeFilled /> : <LikeOutlined />}
              onClick={handleLike}
            />
            <Button
              type="text"
              size="small"
              icon={disliked ? <DislikeFilled /> : <DislikeOutlined />}
              onClick={handleDislike}
            />
            {msg.createdAt && (
              <Text type="secondary" className="message-time">
                {formatTime(msg.createdAt)}
              </Text>
            )}
          </Flex>
        )}
      </Flex>
    </Flex>
  );
}
