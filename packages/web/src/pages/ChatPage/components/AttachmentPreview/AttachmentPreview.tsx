import { useState, useCallback } from "react";
import { Flex, Button, Image, Typography, Spin } from "antd";
import { FileOutlined, CloseOutlined, LoadingOutlined } from "@ant-design/icons";
import type { UploadFile } from "antd/es/upload";
import { isImageType } from "../../../../features/chat/attachment-utils";

const { Text } = Typography;

export interface AttachmentPreviewProps {
  files: UploadFile[];
  onRemove: (uid: string) => void;
}

/**
 * Renders a horizontal strip of attachment thumbnails.
 * Shows a spinner overlay while a file is uploading.
 * Clicking an image opens the antd Image preview modal.
 */
export function AttachmentPreview({ files, onRemove }: AttachmentPreviewProps) {
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewSrc, setPreviewSrc] = useState("");

  const handlePreview = useCallback((file: UploadFile) => {
    if (file.url) {
      setPreviewSrc(file.url);
      setPreviewVisible(true);
    }
  }, []);

  if (files.length === 0) return null;

  return (
    <>
      <Flex gap={10} wrap="wrap" className="chat-composer__attachments">
        {files.map((file) => {
          const isUploading = file.status === "uploading";

          if (isImageType(file)) {
            const thumbSrc = file.url;
            return (
              <Flex
                key={file.uid}
                className="chat-composer__attachment-card"
                onClick={() => {
                  if (!isUploading && file.url) handlePreview(file);
                }}
                style={{ position: "relative" }}
              >
                {thumbSrc ? (
                  <div style={{ position: "relative", width: 72, height: 72 }}>
                    <Image
                      src={thumbSrc}
                      alt={file.name}
                      width={72}
                      height={72}
                      style={{ borderRadius: 10, objectFit: "cover" }}
                      preview={false}
                    />
                    {isUploading && (
                      <Flex
                        align="center"
                        justify="center"
                        style={{
                          position: "absolute",
                          inset: 0,
                          borderRadius: 10,
                          background: "rgba(0,0,0,0.35)",
                        }}
                      >
                        <Spin indicator={<LoadingOutlined style={{ fontSize: 20, color: "#fff" }} spin />} />
                      </Flex>
                    )}
                  </div>
                ) : isUploading ? (
                  <Flex
                    align="center"
                    justify="center"
                    style={{
                      width: 72,
                      height: 72,
                      borderRadius: 10,
                      background: "var(--sp-surface-soft)",
                      border: "1px solid var(--sp-border-soft)",
                    }}
                  >
                    <Spin indicator={<LoadingOutlined style={{ fontSize: 20 }} spin />} />
                  </Flex>
                ) : (
                  <Flex
                    align="center"
                    justify="center"
                    style={{
                      width: 72,
                      height: 72,
                      borderRadius: 10,
                      background: "var(--sp-surface-soft)",
                      border: "1px solid var(--sp-border-soft)",
                    }}
                  >
                    <FileOutlined style={{ fontSize: 22, color: "var(--sp-red)" }} />
                  </Flex>
                )}
                <Button
                  type="text"
                  size="small"
                  className="chat-composer__attachment-remove"
                  icon={<CloseOutlined style={{ fontSize: 10 }} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(file.uid);
                  }}
                  aria-label="移除"
                />
              </Flex>
            );
          }

          return (
            <Flex
              key={file.uid}
              className="chat-composer__attachment-file"
              align="center"
              gap={8}
            >
              {isUploading ? (
                <LoadingOutlined style={{ fontSize: 18, color: "var(--sp-blue)" }} />
              ) : (
                <FileOutlined style={{ fontSize: 18, color: "var(--sp-muted)" }} />
              )}
              <Text ellipsis style={{ maxWidth: 120, fontSize: 12 }}>
                {file.name}
              </Text>
              <Button
                type="text"
                size="small"
                className="chat-composer__attachment-remove"
                icon={<CloseOutlined style={{ fontSize: 10 }} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(file.uid);
                }}
                aria-label="移除"
              />
            </Flex>
          );
        })}
      </Flex>

      <Image
        src={previewSrc}
        alt="预览"
        style={{ display: "none" }}
        preview={{
          visible: previewVisible,
          onVisibleChange: setPreviewVisible,
        }}
      />
    </>
  );
}
