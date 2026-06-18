import { useState, useCallback, useEffect, useRef } from "react";
import type { UploadFile } from "antd/es/upload";
import { uploadFilesToAttachmentRefs } from "../../../features/chat/attachment-utils";
import type { AttachmentRef } from "../../../features/chat/types";
import { useOssUpload } from "./useOssUpload";
import { useDragDrop } from "./useDragDrop";

/** Max file size (bytes) for dataUrl fallback. Larger files must use OSS URL. */
const MAX_DATAURL_BYTES = 4 * 1024 * 1024; // 4 MB

/** Check whether a File is an image by MIME type or extension. */
function isImageFile(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)
  );
}

/**
 * Read a File as a base64 data URL.
 * Returns undefined on failure or if the file exceeds the size limit.
 */
function readFileAsDataUrl(file: File): Promise<string | undefined> {
  if (file.size > MAX_DATAURL_BYTES) return Promise.resolve(undefined);
  if (!isImageFile(file)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string | undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
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
  /** OSS upload progress (0-100). */
  uploadProgress?: number;
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
  useEffect(() => () => { mountedRef.current = false; }, []);

  // ── Add files ────────────────────────────────────────────────────

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      for (const file of incoming) {
        const entry = createUploadFileEntry(file);
        setFiles((prev) => [...prev, entry]);

        // Fire-and-forget upload; guards against setState after unmount
        (async () => {
          try {
            const { url, key } = await uploadFile(file);
            if (!mountedRef.current) return;
            // §P0: When OSS returns no URL (or OSS is unavailable), generate
            // a dataUrl fallback for small images so the backend can still
            // use the image for search/lookup operations.
            let dataUrl: string | undefined;
            if (!url && isImageFile(file)) {
              dataUrl = await readFileAsDataUrl(file);
            }
            setFiles((prev) =>
              prev.map((f) =>
                f.uid === entry.uid
                  ? {
                      ...f,
                      status: "done",
                      url: url || undefined,
                      response: { key, dataUrl },
                    }
                  : f,
              ),
            );
          } catch {
            if (!mountedRef.current) return;
            // §P0: On upload failure, still try to generate a dataUrl for
            // small images so the user can at least search by image.
            let dataUrl: string | undefined;
            if (isImageFile(file)) {
              dataUrl = await readFileAsDataUrl(file);
            }
            setFiles((prev) =>
              prev.map((f) =>
                f.uid === entry.uid
                  ? {
                      ...f,
                      status: dataUrl ? "done" : "error",
                      url: undefined,
                      response: dataUrl ? { dataUrl } : undefined,
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
