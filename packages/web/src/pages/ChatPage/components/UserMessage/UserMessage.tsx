import { Card, Typography, Flex, Image } from "antd";
import { FileOutlined } from "@ant-design/icons";
import type { ChatMessage } from "../../../../features/conversations/types";
import { isImageType } from "../../../../features/chat/attachment-utils";
import "./UserMessage.scss";

const { Paragraph, Text } = Typography;

export function UserMessage({ message }: { message: ChatMessage }) {
  const hasAttachments = message.attachments && message.attachments.length > 0;
  const hasText = message.content.trim().length > 0;

  return (
    <Flex justify="flex-end" className="message-row user">
      <div className="user-bubble">
        <Card size="small" className="user-card">
          {/* ── Upper layer: attachments ───────────────────────── */}
          {hasAttachments && (
            <Flex gap={8} wrap="wrap" className="user-attachments">
              {message.attachments!.map((att) =>
                isImageType(att) ? (
                  <div key={att.id} className="user-attachment-image">
                    {att.url || att.dataUrl ? (
                      <Image
                        src={att.url ?? att.dataUrl}
                        alt={att.name}
                        width="100%"
                        style={{ maxWidth: 200, borderRadius: 8, objectFit: "cover" }}
                        preview={{ mask: "点击预览" }}
                      />
                    ) : (
                      <Flex
                        align="center"
                        justify="center"
                        style={{
                          width: 72,
                          height: 72,
                          borderRadius: 8,
                          background: "var(--sp-surface-soft)",
                          border: "1px solid var(--sp-border-soft)",
                        }}
                      >
                        <FileOutlined style={{ fontSize: 24, color: "var(--sp-muted)" }} />
                      </Flex>
                    )}
                  </div>
                ) : (
                  <Flex
                    key={att.id}
                    align="center"
                    gap={6}
                    className="user-attachment-file"
                  >
                    <FileOutlined style={{ fontSize: 16, color: "var(--sp-muted)" }} />
                    <Text style={{ fontSize: 13 }}>{att.name}</Text>
                  </Flex>
                ),
              )}
            </Flex>
          )}

          {/* ── Lower layer: text ─────────────────────────────── */}
          {hasText && (
            <Paragraph style={{ margin: 0, marginTop: hasAttachments ? 10 : 0 }}>
              {message.content}
            </Paragraph>
          )}
        </Card>
      </div>
    </Flex>
  );
}
