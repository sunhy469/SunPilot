import { useState, useCallback, useRef } from "react";
import { Flex, Button, Typography, message } from "antd";
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
import type { LocalSendState } from "../types";
import { formatTime } from "../../../shared/utils/formatTime";
import { MarkdownRenderer, RichCardRenderer } from "../../../rich-cards";
import { StreamingCursor } from "./StreamingCursor";
import { TypingDots } from "./TypingDots";
import "./AssistantMessage.css";

const { Text } = Typography;

function getAiStatus(
  sendState?: LocalSendState,
  toolName?: string,
): { icon: React.ReactNode; text: string } | null {
  switch (sendState) {
    case "sending":
      return { icon: <LoadingOutlined />, text: "正在连接 SunPilot..." };
    case "accepted":
      return { icon: <LoadingOutlined />, text: "已接收，正在创建运行..." };
    case "running":
      if (toolName) {
        return { icon: <ToolOutlined />, text: `正在调用工具: ${toolName}` };
      }
      return { icon: <LoadingOutlined />, text: "正在准备上下文..." };
    case "streaming":
      if (toolName) {
        return { icon: <ToolOutlined />, text: `正在调用工具: ${toolName}` };
      }
      return { icon: <ThunderboltOutlined />, text: "正在生成回答..." };
    default:
      return null;
  }
}

function getActivityIcon(activity: AgentActivity) {
  if (activity.status === "failed") return <CloseCircleOutlined />;
  if (activity.status === "completed") return <CheckCircleOutlined />;
  if (activity.kind === "tool") return <ToolOutlined />;
  if (activity.kind === "model") return <ThunderboltOutlined />;
  return <LoadingOutlined />;
}

function AgentActivityList({ activities }: { activities?: AgentActivity[] }) {
  if (!activities || activities.length === 0) return null;

  return (
    <div className="assistant-activity-list">
      {activities.map((activity) => (
        <div
          key={activity.id}
          className={`assistant-activity assistant-activity--${activity.status ?? "running"}`}
        >
          <span className="assistant-activity__icon">
            {getActivityIcon(activity)}
          </span>
          <div className="assistant-activity__body">
            <Text className="assistant-activity__label">{activity.label}</Text>
            {activity.detail && (
              <Text type="secondary" className="assistant-activity__detail">
                {activity.detail}
              </Text>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Content-block parts rendering (§Phase 4) ──────────────────────────

function TextPartBlock({
  part,
  isStreaming,
}: {
  part: AssistantTextPart;
  isStreaming: boolean;
}) {
  if (!part.content && !isStreaming) return null;
  return (
    <div className="assistant-markdown-wrap">
      <MarkdownRenderer content={part.content} isStreaming={isStreaming} />
      {isStreaming && <StreamingCursor />}
    </div>
  );
}

function StatusPartBlock({ part }: { part: AssistantStatusPart }) {
  const [collapsed, setCollapsed] = useState(part.status === "completed");
  const isRunning = part.status === "running";
  const isFailed = part.status === "failed";
  const isCompleted = part.status === "completed";

  // §Frontend gap fix: completed status rows collapse to a compact gray line
  const className = [
    "assistant-status-block",
    `assistant-status-block--${part.status}`,
    collapsed && isCompleted ? "assistant-status-block--collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      onClick={() => isCompleted && setCollapsed(!collapsed)}
      style={{ cursor: isCompleted ? "pointer" : "default" }}
    >
      {collapsed && isCompleted ? (
        <Text type="secondary" className="assistant-status-block__collapsed-label">
          ✓ {part.label}
        </Text>
      ) : (
        <>
          <span className="assistant-status-block__icon">
            {isRunning ? (
              <LoadingOutlined />
            ) : isFailed ? (
              <CloseCircleOutlined />
            ) : (
              <CheckCircleOutlined />
            )}
          </span>
          <Text type="secondary" className="assistant-status-block__label">
            {part.label}
          </Text>
          {part.metadata?.progress != null && isRunning && (
            <Text type="secondary" className="assistant-status-block__progress">
              {part.metadata.progress}%
            </Text>
          )}
        </>
      )}
    </div>
  );
}

function ToolUsePartBlock({ part }: { part: AssistantToolUsePart }) {
  const [expanded, setExpanded] = useState(false);
  const hasPreview =
    part.inputPreview && Object.keys(part.inputPreview).length > 0;

  return (
    <div className="assistant-tool-use">
      <Flex
        align="center"
        gap={4}
        className="assistant-tool-use__header"
        onClick={() => hasPreview && setExpanded(!expanded)}
        style={{ cursor: hasPreview ? "pointer" : "default" }}
      >
        {hasPreview &&
          (expanded ? <CaretDownOutlined /> : <CaretRightOutlined />)}
        <ToolOutlined className="assistant-tool-use__icon" />
        <Text type="secondary" className="assistant-tool-use__name">
          {part.name}
        </Text>
      </Flex>
      {expanded && hasPreview && (
        <div className="assistant-tool-use__args">
          {Object.entries(part.inputPreview!).map(([key, value]) => (
            <div key={key} className="assistant-tool-use__arg">
              <Text type="secondary" className="assistant-tool-use__arg-key">
                {key}:
              </Text>{" "}
              <Text className="assistant-tool-use__arg-value">
                {String(value)}
              </Text>
            </div>
          ))}
        </div>
      )}
    </div>
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
    <div className="assistant-tool-result">
      <Flex
        align="center"
        gap={4}
        className="assistant-tool-result__header"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: "pointer" }}
      >
        {expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
        <span className="assistant-tool-result__icon">{icon}</span>
        <Text
          type="secondary"
          ellipsis={{ tooltip: part.summary }}
          className="assistant-tool-result__summary"
        >
          {part.summary}
        </Text>
      </Flex>
      {expanded && (
        <div className="assistant-tool-result__detail">
          <Text type="secondary">{part.summary}</Text>
        </div>
      )}
    </div>
  );
}

function ErrorPartBlock({ part }: { part: AssistantErrorPart }) {
  return (
    <div className="assistant-error-block">
      <CloseCircleOutlined className="assistant-error-block__icon" />
      <Text type="danger" className="assistant-error-block__message">
        {part.message}
      </Text>
    </div>
  );
}

function PartRenderer({
  part,
  isStreaming,
}: {
  part: AssistantMessagePart;
  isStreaming: boolean;
}) {
  switch (part.type) {
    case "text":
      return <TextPartBlock part={part} isStreaming={isStreaming} />;
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

function MessagePartsRenderer({
  parts,
  isStreaming,
}: {
  parts?: AssistantMessagePart[];
  isStreaming: boolean;
}) {
  if (!parts || parts.length === 0) return null;

  return (
    <div className="assistant-parts">
      {parts.map((part) => (
        <PartRenderer
          key={part.id}
          part={part}
          isStreaming={isStreaming && part.type === "text" && part.status === "streaming"}
        />
      ))}
    </div>
  );
}

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
    <div className="message-row assistant">
      <div className="assistant-content">
        {/* ── Content-block parts rendering (§Phase 4) ────────── */}
        {hasParts ? (
          <MessagePartsRenderer
            parts={msg.parts}
            isStreaming={!!isStreaming}
          />
        ) : (
          <>
            {/* ── Stopped state indicator (§Frontend gap) ───────── */}
            {isStopped && (
              <Flex align="center" gap={8} className="assistant-status">
                <span className="assistant-status__icon" style={{ color: "#f59e0b" }}>
                  <ExclamationCircleOutlined />
                </span>
                <Text type="secondary" className="assistant-status__text">
                  已停止生成
                </Text>
              </Flex>
            )}

            {/* ── AI status indicator (before content) ──────────── */}
            {aiStatus && !hasContent && !isStopped && (
              <Flex align="center" gap={8} className="assistant-status">
                <span className="assistant-status__icon">{aiStatus.icon}</span>
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
                <div className="assistant-markdown-wrap">
                  <MarkdownRenderer
                    content={msg.content}
                    isStreaming={!!isStreaming}
                  />
                  {isStreaming && <StreamingCursor />}
                </div>
              )}
            </div>

            {/* §Phase 3e: Hide activities when content-block parts are available.
                Parts rendering replaces AgentActivityList for new messages. */}
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
                <span className="assistant-status__icon">{aiStatus.icon}</span>
                <Text type="secondary" className="assistant-status__text">
                  {aiStatus.text}
                </Text>
              </Flex>
            )}
          </>
        )}

        {/* ── Pending/streaming empty state with parts but no text yet ── */}
        {hasParts && !hasContent && (isPending || (isStreaming && !msg.parts?.some(p => p.type === "text" && (p as AssistantTextPart).content))) && (
          <Flex align="center" gap={8} className="assistant-status">
            <span className="assistant-status__icon">
              {isPending ? <LoadingOutlined /> : <ThunderboltOutlined />}
            </span>
            <Text type="secondary" className="assistant-status__text">
              {isPending ? "正在准备上下文..." : "正在生成回答..."}
            </Text>
            <TypingDots />
          </Flex>
        )}

        {/* ── Tool result completed but no text yet — "summarizing results" ── */}
        {hasParts && !hasContent && isStreaming && msg.parts?.some(p => p.type === "tool_result") && !msg.parts?.some(p => p.type === "text" && (p as AssistantTextPart).content) && (
          <Flex align="center" gap={8} className="assistant-status">
            <span className="assistant-status__icon">
              <LoadingOutlined />
            </span>
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
      </div>
    </div>
  );
}
