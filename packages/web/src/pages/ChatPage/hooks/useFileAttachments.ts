import { useState, useCallback, useEffect, useRef } from "react";
import { message } from "antd";
import type { UploadFile } from "antd/es/upload";
import { uploadFilesToAttachmentRefs } from "../../../features/chat/attachment-utils";
import type { AttachmentRef } from "../../../features/chat/types";
import { useOssUpload } from "./useOssUpload";
import { useDragDrop } from "./useDragDrop";

// W3: attachment upload limits — kept in sync with ChatComposer's `accept`.
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB per file
const MAX_FILE_COUNT = 10; // max attachments per message
/** Extensions allowed when the MIME type isn't image/* or video/*. */
const ALLOWED_EXTENSIONS = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "txt", "md", "json", "csv", "zip", "tar", "gz",
];

/** W3: validate a single file against the size + type whitelist. */
function isAllowedFile(file: File): boolean {
  // image/* and video/* MIME types are always allowed
  if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
    return true;
  }
  // Otherwise fall back to extension matching (MIME can be empty/unreliable)
  const dotIndex = file.name.lastIndexOf(".");
  const ext = dotIndex >= 0 ? file.name.slice(dotIndex + 1).toLowerCase() : "";
  return ALLOWED_EXTENSIONS.includes(ext);
}

export interface FileAttachmentsState {
  /** Current attachment list (antd UploadFile format). */
  files: UploadFile[];
  /** Whether a drag operation is hovering over the drop zone. */
  dragOver: boolean;
  /** Drag event handlers to spread onto the drop zone. */
  dragHandlers: ReturnType<typeof useDragDrop>["handlers"];
  /** Whether an OSS upload is in progress. */
  uploading: boolean;
  /** W10: per-file OSS upload progress keyed by uid (0-100). */
  uploadProgress?: Record<string, number>;
}

/**
 * Unified hook that owns all attachment-related state and operations.
 *
 * Combines:
 * - OSS upload flow (via useOssUpload)
 * - Drag-and-drop (via useDragDrop)
 * - Clipboard paste handling
 * - Remove / clear operations
 * - Conversion to AttachmentRef[] for sending
 */
export function useFileAttachments() {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const { uploadFile, state: ossState, createUploadFileEntry } = useOssUpload();
  const mountedRef = useRef(true);
  // W3: mirror files in a ref so addFiles can read the current count without
  // adding `files` to its dependency array.
  const filesRef = useRef<UploadFile[]>([]);
  filesRef.current = files;
  useEffect(() => () => { mountedRef.current = false; }, []);

  // ── Add files ────────────────────────────────────────────────────

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);

      // W3: enforce per-file size + type whitelist
      const valid: File[] = [];
      for (const file of incoming) {
        if (file.size > MAX_FILE_SIZE_BYTES) {
          message.error(`文件「${file.name}」超过 50MB 限制`);
          continue;
        }
        if (!isAllowedFile(file)) {
          message.error(`文件「${file.name}」类型不支持`);
          continue;
        }
        valid.push(file);
      }

      // W3: enforce total attachment count limit
      const currentCount = filesRef.current.length;
      const remainingSlots = MAX_FILE_COUNT - currentCount;
      if (remainingSlots <= 0) {
        message.error(`最多只能上传 ${MAX_FILE_COUNT} 个附件`);
        return;
      }
      const toAdd = valid.slice(0, remainingSlots);
      if (valid.length > remainingSlots) {
        message.error(
          `最多只能上传 ${MAX_FILE_COUNT} 个附件，已忽略多余的 ${valid.length - remainingSlots} 个`,
        );
      }

      for (const file of toAdd) {
        const entry = createUploadFileEntry(file);
        setFiles((prev) => [...prev, entry]);

        // Fire-and-forget upload; guards against setState after unmount
        (async () => {
          try {
            const { url, key } = await uploadFile(file, entry.uid);
            if (!mountedRef.current) return;
            if (!url) throw new Error("OSS upload completed without a public URL");
            setFiles((prev) =>
              prev.map((f) =>
                f.uid === entry.uid
                  ? {
                      ...f,
                      status: "done",
                      url,
                      thumbUrl: url,
                      response: { key },
                    }
                  : f,
              ),
            );
          } catch {
            if (!mountedRef.current) return;
            setFiles((prev) =>
              prev.map((f) =>
                f.uid === entry.uid
                  ? {
                      ...f,
                      status: "error",
                      url: undefined,
                      thumbUrl: undefined,
                      response: undefined,
                    }
                  : f,
              ),
            );
          }
        })();
      }
    },
    [createUploadFileEntry, uploadFile],
  );

  const addFilesFromPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) addFiles(files);
    },
    [addFiles],
  );

  // ── Drag-and-drop ────────────────────────────────────────────────

  const { dragOver, handlers: dragHandlers } = useDragDrop(addFiles);

  // ── Remove / clear ───────────────────────────────────────────────

  const removeFile = useCallback((uid: string) => {
    setFiles((prev) => prev.filter((f) => f.uid !== uid));
  }, []);

  const clearFiles = useCallback(() => {
    setFiles([]);
  }, []);

  // ── Convert for sending ──────────────────────────────────────────

  const toAttachmentRefs = useCallback((): AttachmentRef[] => {
    return uploadFilesToAttachmentRefs(files);
  }, [files]);

  return {
    files,
    dragOver,
    dragHandlers,
    uploading: ossState.uploading,
    uploadProgress: ossState.progress,
    addFiles,
    addFilesFromPaste,
    removeFile,
    clearFiles,
    toAttachmentRefs,
  };
}
