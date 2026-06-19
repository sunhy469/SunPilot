import { useState, useCallback, useRef, useEffect, useMemo } from "react";
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
import type { AgentActivity } from "../../../features/conversations/types";
import type {
  ChatMessage,
  AssistantMessagePart,
  AssistantTextPart,
  AssistantStatusPart,
  AssistantToolUsePart,
  AssistantToolResultPart,
  AssistantErrorPart,
} from "../../../features/conversations/types";
import type { TableCardData } from "../../../rich-cards/types";
import { MarkdownRenderer, RichCardRenderer } from "../../../rich-cards";
import { TableCard } from "../../../rich-cards/components/TableCard";
import { GalleryCard } from "../../../rich-cards/components/MediaCards";
import type { LocalSendState } from "../types";
import { formatTime } from "../../../shared/utils/formatTime";
import { StreamingCursor } from "./StreamingCursor";
import { TypingDots } from "./TypingDots";
import "./AssistantMessage.css";

const { Text } = Typography;

// ── Markdown structured content extraction ──────────────────────────

interface ExtractedContent {
  tables: TableCardData[];
  images: Array<{ src: string; alt?: string; caption?: string }>;
  remainingMarkdown: string;
}

/**
 * Extract tables and images from completed Markdown content,
 * returning them as Rich Card data alongside the remaining Markdown text.
 */
function extractStructuredContent(markdown: string): ExtractedContent {
  const tables: TableCardData[] = [];
  const images: Array<{ src: string; alt?: string; caption?: string }> = [];
  const remainingLines: string[] = [];

  const lines = markdown.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;

    // ── Table extraction ──
    // A Markdown table: header row | separator row | data rows
    if (
      line?.includes("|") &&
      nextLine &&
      /^\|?\s*[-:]+[-|\s:]*$/.test(nextLine)
    ) {
      const headers = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      const dataLines: string[] = [];
      let j = i + 2;

      while (j < lines.length && lines[j]?.includes("|")) {
        dataLines.push(lines[j]!);
        j++;
      }

      // Parse data rows
      const rows = dataLines.map((dataLine) => {
        const cells = dataLine
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean);
        const row: Record<string, string | number> = {};
        headers.forEach((h, idx) => {
          row[h] = cells[idx] ?? "";
        });
        return row;
      });

      if (headers.length > 0 && rows.length > 0) {
        tables.push({
          columns: headers.map((h) => ({
            key: h,
            label: h,
          })),
          rows,
        });
      }

      i = j;
      continue;
    }

    // ── Image extraction ──
    const imgMatch = line?.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgMatch) {
      images.push({
        alt: imgMatch[1] || undefined,
        src: imgMatch[2] ?? "",
        caption: imgMatch[1] || undefined,
      });
      i++;
      continue;
    }

    if (line !== undefined) {
      remainingLines.push(line);
    }
    i++;
  }

  return {
    tables,
    images,
    remainingMarkdown: remainingLines.join("\n"),
  };
}

// ── Product content renderer (Rich Card + Streamdown) ───────────────

function ProductContentRenderer({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  // 流式中：直接用 MarkdownRenderer 渲染全部内容
  if (isStreaming) {
    return (
      <div className="assistant-markdown-wrap">
        <MarkdownRenderer content={content} isStreaming />
        <StreamingCursor />
      </div>
    );
  }

  // 完成后：提取结构化内容，分别渲染
  const { tables, images, remainingMarkdown } = useMemo(
    () => extractStructuredContent(content),
    [content],
  );

  const hasRemaining = remainingMarkdown.trim().length > 0;
  const hasTables = tables.length > 0;
  const hasImages = images.length > 0;

  if (!hasRemaining && !hasTables && !hasImages) return null;

  return (
    <Flex vertical gap={12} className="assistant-markdown-wrap">
      {hasRemaining && <MarkdownRenderer content={remainingMarkdown} />}
      {tables.map((table, idx) => (
        <TableCard key={`table-${idx}`} data={table} />
      ))}
      {hasImages && <GalleryCard data={{ images }} />}
    </Flex>
  );
}

// ── AI status mapping ───────────────────────────────────────────────

function getAiStatus(
  sendState?: LocalSendState,
  toolName?: string,
): { icon: React.ReactNode; text: string } | null {
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
        text: "正在准备上下文...",
      };
    case "streaming":
      if (toolName) {
        return { icon: <ToolOutlined />, text: `正在调用工具: ${toolName}` };
      }
      return { icon: <ThunderboltOutlined />, text: "正在思考" };
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
                {String(value)}
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

// ── Thinking process section (collapsible) ──────────────────────────

function ThinkingProcessSection({
  parts,
  isStreaming,
}: {
  parts: AssistantMessagePart[];
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

  if (parts.length === 0) return null;

  const stepCount = parts.length;

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
        {parts.map((part) => (
          <PartRenderer
            key={part.id}
            part={part}
            isStreaming={isStreaming}
            variant="thinking"
          />
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
  // When NO text part has semanticRole set, fall back to the legacy
  // last-text-is-final rule for backward compatibility with old data.
  const hasSemanticRoles = normalizedParts.some(
    (p) => p.type === "text" && (p as { semanticRole?: string }).semanticRole,
  );

  let lastTextIdx = -1;
  if (!hasSemanticRoles) {
    for (let i = normalizedParts.length - 1; i >= 0; i--) {
      if (normalizedParts[i]!.type === "text") {
        lastTextIdx = i;
        break;
      }
    }
  }

  // 分组：按 semanticRole 或 fallback 规则
  const thinkingParts: AssistantMessagePart[] = [];
  const productParts: AssistantMessagePart[] = [];

  for (let i = 0; i < normalizedParts.length; i++) {
    const part = normalizedParts[i]!;
    if (part.type === "error") {
      productParts.push(part);
    } else if (part.type === "text") {
      const role = (part as { semanticRole?: string }).semanticRole;
      if (role === "final") {
        productParts.push(part);
      } else if (role === "progress") {
        thinkingParts.push(part);
      } else {
        // Legacy fallback: last text part is final, rest are thinking
        if (i === lastTextIdx) {
          productParts.push(part);
        } else {
          thinkingParts.push(part);
        }
      }
    } else {
      thinkingParts.push(part);
    }
  }

  return (
    <Flex vertical gap={8} className="assistant-parts">
      {/* 思考过程折叠区（包含思考文本 + status + tool_use + tool_result） */}
      <ThinkingProcessSection parts={thinkingParts} isStreaming={isStreaming} />

      {/* 产物区（最终文本 + 错误） */}
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
  sendState,
  toolName,
}: {
  message: ChatMessage;
  isStreaming?: boolean;
  cards?: ChatMessage["cards"];
  sendState?: LocalSendState;
  toolName?: string;
}) {
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const likedRef = useRef(liked);
  const dislikedRef = useRef(disliked);
  likedRef.current = liked;
  dislikedRef.current = disliked;
  const hasContent = msg.content.length > 0;
  const hasParts = msg.parts && msg.parts.length > 0;
  // §Dynamic title: When thinking-related parts (status, tool, progress text)
  // exist, the ThinkingProcessSection already shows "正在思考..." in its
  // title. Suppress external status bars to avoid duplication.
  const hasThinkingParts =
    hasParts &&
    msg.parts!.some(
      (p) =>
        p.type === "status" ||
        p.type === "tool_use" ||
        p.type === "tool_result" ||
        (p.type === "text" &&
          (p as AssistantTextPart).semanticRole === "progress"),
    );
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

            {/* ── AI status indicator (before content) ──────────── */}
            {aiStatus && !hasContent && !isStopped && (
              <Flex align="center" gap={8} className="assistant-status">
                {aiStatus.icon}
                <Text type="secondary" className="assistant-status__text">
                  {aiStatus.text}
                </Text>
              </Flex>
            )}

            {/* ── Text content ─────────────────────────────────── */}
            <div className="assistant-text">
              {!hasContent && isStreaming && !aiStatus ? <TypingDots /> : null}
              {!hasContent && isPending && !aiStatus ? <TypingDots /> : null}
              {hasContent && (
                <ProductContentRenderer
                  content={msg.content}
                  isStreaming={!!isStreaming}
                />
              )}
            </div>

            {/* Hide activities when content-block parts are available. */}
            {(!msg.parts || msg.parts.length === 0) && (
              <AgentActivityList activities={msg.activities} />
            )}

            {/* ── AI status indicator (inline, below content) ──── */}
            {aiStatus && hasContent && (
              <Flex
                align="center"
                gap={8}
                className="assistant-status assistant-status--inline"
              >
                {aiStatus.icon}
                <Text type="secondary" className="assistant-status__text">
                  {aiStatus.text}
                </Text>
              </Flex>
            )}
          </>
        )}

        {/* ── Pending/streaming empty state with parts but no text yet ── */}
        {/* §Dynamic title: Suppress when thinking parts are already displayed
            by ThinkingProcessSection (avoids duplicate "正在思考" bars). */}
        {hasParts &&
          !hasContent &&
          !hasThinkingParts &&
          (isPending ||
            (isStreaming &&
              !msg.parts?.some(
                (p) => p.type === "text" && (p as AssistantTextPart).content,
              ))) && (
            <Flex align="center" gap={8} className="assistant-status">
              {isPending ? (
                <LoadingOutlined className="assistant-status__icon assistant-loading-icon" />
              ) : (
                <ThunderboltOutlined />
              )}
              <Text type="secondary" className="assistant-status__text">
                {isPending ? "正在准备上下文..." : "正在思考"}
              </Text>
              <TypingDots />
            </Flex>
          )}

        {/* ── Tool result completed but no text yet ── */}
        {/* §Dynamic title: Also suppressed when thinking parts are displayed. */}
        {hasParts &&
          !hasContent &&
          isStreaming &&
          !hasThinkingParts &&
          msg.parts?.some((p) => p.type === "tool_result") &&
          !msg.parts?.some(
            (p) => p.type === "text" && (p as AssistantTextPart).content,
          ) && (
            <Flex align="center" gap={8} className="assistant-status">
              <LoadingOutlined className="assistant-status__icon assistant-loading-icon" />
              <Text type="secondary" className="assistant-status__text">
                正在整理结果...
              </Text>
              <TypingDots />
            </Flex>
          )}

        {/* ── Rich cards (video, image, etc.) ─────────────────── */}
        {cards && cards.length > 0 && <RichCardRenderer cards={cards} />}

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
