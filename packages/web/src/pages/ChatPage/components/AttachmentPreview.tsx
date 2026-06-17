import { useState, useCallback, useEffect, useRef } from "react";
import { Flex, Button, Image, Typography, Spin } from "antd";
import { FileOutlined, CloseOutlined, LoadingOutlined } from "@ant-design/icons";
import type { UploadFile } from "antd/es/upload";

const { Text } = Typography;

function isImageFile(file: UploadFile): boolean {
  return (
    file.type?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)
  );
}

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
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const handlePreview = useCallback((file: UploadFile) => {
    if (file.url || file.preview) {
      setPreviewSrc((file.url ?? file.preview) as string);
      setPreviewVisible(true);
      return;
    }
    if (file.originFileObj) {
      const reader = new FileReader();
      reader.onload = () => {
        if (mountedRef.current) {
          setPreviewSrc(reader.result as string);
          setPreviewVisible(true);
        }
      };
      reader.onerror = () => {
        if (mountedRef.current) {
          setPreviewSrc("");
        }
      };
      reader.readAsDataURL(file.originFileObj);
    }
  }, []);

  if (files.length === 0) return null;

  return (
    <>
      <Flex gap={10} wrap="wrap" className="chat-composer__attachments">
        {files.map((file) => {
          const isUploading = file.status === "uploading";

          if (isImageFile(file)) {
            return (
              <Flex
                key={file.uid}
                className="chat-composer__attachment-card"
                onClick={() => !isUploading && handlePreview(file)}
                style={{ position: "relative" }}
              >
                {isUploading ? (
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
                  <Image
                    src={file.thumbUrl ?? file.url ?? undefined}
                    alt={file.name}
                    width={72}
                    height={72}
                    style={{ borderRadius: 10, objectFit: "cover" }}
                    preview={false}
                  />
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
