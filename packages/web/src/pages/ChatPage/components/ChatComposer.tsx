import { useState, useCallback, useRef, type ReactNode } from "react";
import {
  Input,
  Button,
  Flex,
  Select,
  Upload,
  Image,
  Typography,
  Space,
} from "antd";
import {
  SendOutlined,
  StopOutlined,
  PlusOutlined,
  FileOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import type { UploadFile } from "antd/es/upload";
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
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
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
}: {
  placeholder?: string;
  disabled?: boolean;
  streaming?: boolean;
  variant?: "default" | "welcome";
  value?: string;
  onChange?: (value: string) => void;
  onSend: (text: string) => void;
  onStop?: () => void;
}) {
  const [internalValue, setInternalValue] = useState("");
  const [attachments, setAttachments] = useState<UploadFile[]>([]);
  const [permission, setPermission] = useState("auto");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewSrc, setPreviewSrc] = useState("");
  const textareaRef = useRef<any>(null);

  const isControlled = value !== undefined;
  const currentValue = value ?? internalValue;
  const setCurrentValue = useCallback(
    (next: string) => {
      if (!isControlled) setInternalValue(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  const handleSend = useCallback(() => {
    const text = currentValue.trim();
    if (!text || disabled) return;
    onSend(text);
    setCurrentValue("");
  }, [currentValue, disabled, onSend, setCurrentValue]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleRemoveAttachment = useCallback((e: React.MouseEvent, uid: string) => {
    e.stopPropagation();
    setAttachments((prev) => prev.filter((f) => f.uid !== uid));
  }, []);

  const handlePreview = useCallback((file: UploadFile) => {
    if (file.url || file.preview) {
      setPreviewSrc((file.url ?? file.preview) as string);
      setPreviewVisible(true);
      return;
    }
    if (file.originFileObj) {
      const reader = new FileReader();
      reader.onload = () => {
        setPreviewSrc(reader.result as string);
        setPreviewVisible(true);
      };
      reader.readAsDataURL(file.originFileObj);
    }
  }, []);

  const isImage = (file: UploadFile) =>
    file.type?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);

  const isWelcome = variant === "welcome";
  const hasAttachments = attachments.length > 0;

  return (
    <Flex
      vertical
      className={`chat-composer${isWelcome ? " chat-composer--welcome" : ""}`}
    >
      {/* ── Top layer: attachment preview ───────────────────────── */}
      {hasAttachments && (
        <Flex
          gap={10}
          wrap="wrap"
          className="chat-composer__attachments"
        >
          {attachments.map((file) =>
            isImage(file) ? (
              <Flex
                key={file.uid}
                className="chat-composer__attachment-card"
                onClick={() => handlePreview(file)}
              >
                <Image
                  src={file.thumbUrl ?? file.url ?? undefined}
                  alt={file.name}
                  width={72}
                  height={72}
                  style={{ borderRadius: 10, objectFit: "cover" }}
                  preview={false}
                />
                <Button
                  type="text"
                  size="small"
                  className="chat-composer__attachment-remove"
                  icon={<CloseOutlined style={{ fontSize: 10 }} />}
                  onClick={(e) => handleRemoveAttachment(e, file.uid)}
                  aria-label="移除"
                />
              </Flex>
            ) : (
              <Flex
                key={file.uid}
                className="chat-composer__attachment-file"
                align="center"
                gap={8}
              >
                <FileOutlined style={{ fontSize: 18, color: "var(--sp-muted)" }} />
                <Text ellipsis style={{ maxWidth: 120, fontSize: 12 }}>
                  {file.name}
                </Text>
                <Button
                  type="text"
                  size="small"
                  className="chat-composer__attachment-remove"
                  icon={<CloseOutlined style={{ fontSize: 10 }} />}
                  onClick={(e) => handleRemoveAttachment(e, file.uid)}
                  aria-label="移除"
                />
              </Flex>
            ),
          )}
        </Flex>
      )}

      {/* ── Middle layer: text input ────────────────────────────── */}
      <TextArea
        ref={textareaRef}
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
            onChange={(info) => setAttachments(info.fileList)}
            fileList={attachments}
            accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.json,.csv,.zip,.tar,.gz"
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
          {streaming && onStop ? (
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
              disabled={disabled || !currentValue.trim()}
              onClick={handleSend}
            />
          )}
        </Space>
      </Flex>

      {/* ── Preview modal ──────────────────────────────────────── */}
      <Image
        src={previewSrc}
        alt="预览"
        style={{ display: "none" }}
        preview={{
          visible: previewVisible,
          onVisibleChange: setPreviewVisible,
        }}
      />
    </Flex>
  );
}
