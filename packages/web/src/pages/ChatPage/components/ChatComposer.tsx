import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import {
  Input,
  Button,
  Flex,
  Select,
  Upload,
  Typography,
  Space,
} from "antd";
import {
  SendOutlined,
  StopOutlined,
  PlusOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { AttachmentRef } from "../../../features/chat/types";
import { validateAttachmentsForSend } from "../../../features/chat/attachment-utils";
import { useFileAttachments } from "../hooks/useFileAttachments";
import { AttachmentPreview } from "./AttachmentPreview";
import type { LocalSendState } from "../types";
import "./ChatComposer.css";

const { TextArea } = Input;
const { Text } = Typography;

// ── SVG Icons ─────────────────────────────────────────────────────────

function HandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6a2 2 0 0 0-4 0v1" />
      <path d="M14 10V4a2 2 0 0 0-4 0v4" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.2 0-4.2-.9-5.6-2.4l-1.7-1.9c-.5-.5-.7-1.2-.5-1.9.3-.9 1.3-1.4 2.2-1l1.8.7V6a2 2 0 1 1 4 0v7" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

// ── Permission options ────────────────────────────────────────────────

interface PermissionOption {
  value: string;
  label: string;
  description: string;
  icon: ReactNode;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  {
    value: "ask",
    label: "请求批准",
    description: "编辑外部文件和使用互联网时始终询问",
    icon: <HandIcon />,
  },
  {
    value: "auto",
    label: "替我审批",
    description: "仅对检测到的风险操作请求批准",
    icon: <ShieldIcon />,
  },
  {
    value: "full",
    label: "完全访问权限",
    description: "可不受限制地访问互联网和您电脑上的任何文件",
    icon: <AlertIcon />,
  },
];

// ── Model options ─────────────────────────────────────────────────────

const MODEL_OPTIONS = [
  { value: "dp", label: "DeepSeek-4.0-flash" },
  { value: "seed", label: "Seed-pro" },
];

// ── Component ─────────────────────────────────────────────────────────

export function ChatComposer({
  placeholder = "向 SunPilot 提问...",
  disabled,
  streaming,
  variant = "default",
  value,
  onChange,
  onSend,
  onStop,
  sendState,
  onSendStateChange,
}: {
  placeholder?: string;
  disabled?: boolean;
  streaming?: boolean;
  variant?: "default" | "welcome";
  value?: string;
  onChange?: (value: string) => void;
  onSend: (text: string, attachments?: AttachmentRef[], permissionMode?: "ask" | "auto" | "full", modelId?: "dp" | "seed") => void;
  onStop?: () => void;
  /** Global send state from useChat — drives consistent UI across components. */
  sendState?: LocalSendState;
  /** Report upload/queue state changes to parent so useChat.sendState stays in sync. */
  onSendStateChange?: (state: LocalSendState) => void;
}) {
  const [internalValue, setInternalValue] = useState("");
  const [permission, setPermission] = useState("auto");
  const [model, setModel] = useState("seed");
  // Track queued send when user clicks send while uploads are in progress
  const [queuedSend, setQueuedSend] = useState(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  // Preserve the last sent text and attachments for retry on failure
  const lastSentRef = useRef<{ text: string; hasFiles: boolean }>({ text: "", hasFiles: false });

  const {
    files,
    dragOver,
    dragHandlers,
    uploading,
    uploadProgress,
    addFiles,
    addFilesFromPaste,
    removeFile,
    clearFiles,
    toAttachmentRefs,
  } = useFileAttachments();

  const isControlled = value !== undefined;
  const currentValue = value ?? internalValue;
  const setCurrentValue = useCallback(
    (next: string) => {
      if (!isControlled) setInternalValue(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  // ── Restore input on send failure ────────────────────────────────
  // When sendState transitions to "failed", restore the user's text
  // and keep attachments so they don't lose their input.
  const prevSendStateRef = useRef<LocalSendState | undefined>(undefined);
  const currentValueRef = useRef(currentValue);
  currentValueRef.current = currentValue;
  useEffect(() => {
    const prev = prevSendStateRef.current;
    prevSendStateRef.current = sendState;
    if (
      sendState === "failed" &&
      prev &&
      prev !== "failed" &&
      prev !== "editing" &&
      lastSentRef.current.text
    ) {
      // Restore text if it was cleared by the send handler
      if (!currentValueRef.current.trim()) {
        setCurrentValue(lastSentRef.current.text);
      }
    }
  }, [sendState, setCurrentValue]);

  // ── Sync upload state to global sendState ─────────────────────────
  // Report state changes so useChat.sendState reflects upload progress,
  // enabling consistent UI across the ChatPage (sidebar, header, etc.).
  //
  // State transitions:
  //   uploading && queuedSend → "queued_until_upload_done"
  //   uploading && !queuedSend → "uploading"
  //   !uploading && uploadFailed → "failed"
  //   !uploading && !uploadFailed && was uploading → "editing" (clean finish)

  const wasUploadingRef = useRef(false);

  useEffect(() => {
    if (uploading) {
      wasUploadingRef.current = true;
      onSendStateChange?.(queuedSend ? "queued_until_upload_done" : "uploading");
    } else if (uploadFailed) {
      wasUploadingRef.current = false;
      onSendStateChange?.("failed");
    } else if (wasUploadingRef.current) {
      // Uploads completed cleanly — return to editing so UI reflects the
      // ready-to-send state. This fixes the gap where sendState was stuck
      // at "uploading" after attachment uploads finished.
      wasUploadingRef.current = false;
      onSendStateChange?.("editing");
    }
  }, [uploading, queuedSend, uploadFailed, onSendStateChange]);

  // ── Auto-send when uploads complete ────────────────────────────────
  // Architecture doc §12.2–§12.3: If the user clicks send while attachments
  // are still uploading, queue the message and auto-send once OSS uploads
  // finish. The UI shows "附件上传完成后将自动发送" while queued.

  useEffect(() => {
    if (!queuedSend || uploading) return;
    // All uploads finished — fire the queued send
    setQueuedSend(false);

    // §Phase 2b: Validate image attachments have usable refs before auto-send
    const validation = validateAttachmentsForSend(files);
    if (validation.missingImageRef) {
      setUploadFailed(true);
      onSendStateChange?.("failed");
      return;
    }

    const text = currentValue.trim();
    onSend(text || "请查看附件", toAttachmentRefs(), permission as "ask" | "auto" | "full", model as "dp" | "seed");
    clearFiles();
    setCurrentValue("");
    onSendStateChange?.("sending");
  }, [uploading, queuedSend, currentValue, onSend, toAttachmentRefs, clearFiles, setCurrentValue, onSendStateChange, permission, model, files]);

  // ── Send ──────────────────────────────────────────────────────────

  const handleSend = useCallback(() => {
    const text = currentValue.trim();
    const hasContent = text.length > 0 || files.length > 0;
    if (!hasContent || disabled) return;

    // Remember what was sent for retry-on-failure preservation
    lastSentRef.current = { text, hasFiles: files.length > 0 };

    // If uploads are still in progress, queue the send instead of
    // blocking. The user gets immediate feedback: "附件上传完成后将自动发送".
    if (uploading) {
      setQueuedSend(true);
      onSendStateChange?.("queued_until_upload_done");
      return;
    }

    // §Phase 2b: Send gate — validate image attachments have usable references.
    // Block send when image files exist but lack both url and dataUrl.
    // This prevents the "UI shows image but backend gets nothing" illusion.
    const validation = validateAttachmentsForSend(files);
    if (validation.missingImageRef) {
      setUploadFailed(true);
      onSendStateChange?.("failed");
      return;
    }

    onSend(text || "请查看附件", toAttachmentRefs(), permission as "ask" | "auto" | "full", model as "dp" | "seed");
    clearFiles();
    setCurrentValue("");
  }, [currentValue, disabled, files, uploading, onSend, setCurrentValue, toAttachmentRefs, clearFiles, onSendStateChange, permission, model]);

  // ── Detect upload failures ────────────────────────────────────────
  // When uploads complete, check for any files with error status.
  useEffect(() => {
    if (!uploading && files.some((f) => f.status === "error")) {
      setUploadFailed(true);
    } else if (!uploading) {
      setUploadFailed(false);
    }
  }, [uploading, files]);

  // ── Retry failed upload ───────────────────────────────────────────
  // Re-upload files that failed. The failed files are removed and
  // re-added through addFiles, which triggers fresh OSS uploads.
  const handleRetryUpload = useCallback(() => {
    setUploadFailed(false);
    const failedFiles = files.filter((f) => f.status === "error");
    // Collect originFileObj from failed entries to re-upload
    const retryFiles = failedFiles
      .map((f) => f.originFileObj)
      .filter((f): f is File => f instanceof File);
    // Remove the failed entries
    for (const f of failedFiles) {
      removeFile(f.uid);
    }
    // Re-add valid origin files for fresh upload
    if (retryFiles.length > 0) {
      addFiles(retryFiles);
    }
  }, [files, removeFile, addFiles]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // ── Class names / derived state ──────────────────────────────────

  const isWelcome = variant === "welcome";
  const isQueued = queuedSend && uploading;
  const isActiveSending = sendState === "sending";
  const isAiProcessing =
    sendState === "accepted" ||
    sendState === "running" ||
    sendState === "streaming";
  const sendDisabled =
    disabled ||
    (!currentValue.trim() && files.length === 0) ||
    isQueued ||
    isActiveSending;

  // Status label for the current phase — displayed below the input
  const statusLabel: string | undefined = (() => {
    switch (sendState) {
      case "uploading": return undefined;
      case "sending": return "发送中...";
      case "failed": return "发送失败，请重试";
      default: return undefined;
    }
  })();

  const className = [
    "chat-composer",
    isWelcome && "chat-composer--welcome",
    dragOver && "chat-composer--drag-over",
  ]
    .filter(Boolean)
    .join(" ");

  // ── Render ────────────────────────────────────────────────────────

  return (
    <Flex vertical className={className} {...dragHandlers} onPaste={addFilesFromPaste}>
      {/* ── Top layer: attachment preview ───────────────────────── */}
      <AttachmentPreview files={files} onRemove={removeFile} />

      {/* ── Middle layer: text input ────────────────────────────── */}
      <TextArea
        className="chat-composer__input"
        aria-label="Message"
        placeholder={placeholder}
        value={currentValue}
        rows={3}
        disabled={disabled}
        autoSize={{ minRows: 2, maxRows: 6 }}
        onChange={(e) => setCurrentValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      {uploadFailed && (
        <div className="chat-composer__upload-status">
          <Text type="danger" style={{ fontSize: 12 }}>
            附件上传失败，
            <Button type="link" size="small" onClick={handleRetryUpload} style={{ padding: 0 }}>
              点击重试
            </Button>
          </Text>
        </div>
      )}

      {/* ── Send state indicator ────────────────────────────────── */}
      {statusLabel && (
        <div className="chat-composer__status-bar">
          {isActiveSending && <LoadingOutlined style={{ marginRight: 6 }} />}
          <Text
            type={sendState === "failed" ? "danger" : "secondary"}
            style={{ fontSize: 12 }}
          >
            {statusLabel}
          </Text>
        </div>
      )}

      {/* ── Bottom layer: controls ──────────────────────────────── */}
      <Flex
        justify="space-between"
        align="center"
        className="chat-composer__controls"
      >
        <Space size={8}>
          <Upload
            multiple
            showUploadList={false}
            beforeUpload={() => false}
            fileList={files}
            accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.json,.csv,.zip,.tar,.gz"
            onChange={(info) => {
              const originFile = info.file.originFileObj;
              if (originFile) {
                addFiles([originFile]);
              }
            }}
          >
            <Button
              type="text"
              shape="circle"
              size="small"
              icon={<PlusOutlined />}
              aria-label="添加附件"
            />
          </Upload>
          <Select
            variant="borderless"
            value={permission}
            onChange={setPermission}
            size="small"
            className="chat-composer__select"
            popupMatchSelectWidth={false}
            options={PERMISSION_OPTIONS.map((opt) => ({
              value: opt.value,
              label: (
                <Flex gap={8} align="center">
                  <span style={{ color: "var(--sp-muted)", display: "flex" }}>
                    {opt.icon}
                  </span>
                  <Flex vertical gap={0}>
                    <Text style={{ fontSize: 14 }}>{opt.label}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {opt.description}
                    </Text>
                  </Flex>
                </Flex>
              ),
            }))}
            optionRender={(option) => {
              const opt = PERMISSION_OPTIONS.find((o) => o.value === option.value);
              if (!opt) return option.label;
              return (
                <Flex gap={8} align="center" style={{ padding: "2px 0" }}>
                  <span style={{ color: "var(--sp-muted)", display: "flex", flexShrink: 0 }}>
                    {opt.icon}
                  </span>
                  <Flex vertical gap={0}>
                    <Text style={{ fontSize: 14 }}>{opt.label}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {opt.description}
                    </Text>
                  </Flex>
                </Flex>
              );
            }}
            labelRender={(props) => {
              const opt = PERMISSION_OPTIONS.find((o) => o.value === props.value);
              if (!opt) return props.label;
              return (
                <Flex gap={6} align="center">
                  <span style={{ color: "var(--sp-muted)", display: "flex" }}>
                    {opt.icon}
                  </span>
                  <Text style={{ fontSize: 14 }}>{opt.label}</Text>
                </Flex>
              );
            }}
          />
        </Space>

        <Space size={8}>
          <Select
            variant="borderless"
            value={model}
            onChange={setModel}
            options={MODEL_OPTIONS}
            size="small"
            className="chat-composer__select"
            popupMatchSelectWidth={false}
          />
          {(streaming || isAiProcessing || isActiveSending) && onStop ? (
            <Button
              type="primary"
              danger
              shape="circle"
              size="small"
              icon={<StopOutlined />}
              aria-label="停止"
              onClick={onStop}
            />
          ) : (
            <Button
              type="primary"
              shape="circle"
              size="small"
              icon={<SendOutlined />}
              aria-label="发送"
              disabled={sendDisabled}
              onClick={handleSend}
            />
          )}
        </Space>
      </Flex>
    </Flex>
  );
}
