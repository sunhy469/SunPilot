import { useCallback, useState } from "react";
import type { UploadFile } from "antd/es/upload";
import { requestPresignedUrl, uploadToOss } from "../../../features/chat/upload";

export interface OssUploadState {
  /** Whether an upload is currently in progress. */
  uploading: boolean;
  /** W10: per-file upload progress keyed by uid (0-100), so concurrent uploads
   *  no longer share a single progress value that jumps between files. */
  progress?: Record<string, number>;
}

/**
 * Hook that encapsulates the OSS presign → upload flow.
 */
export function useOssUpload() {
  const [state, setState] = useState<OssUploadState>({ uploading: false });

  const uploadFile = useCallback(
    async (file: File, uid: string): Promise<{ url: string; key: string }> => {
      // W10: track this file's progress independently under its uid.
      setState((prev) => ({
        uploading: true,
        progress: { ...(prev.progress ?? {}), [uid]: 0 },
      }));

      try {
        const { presignedUrl, publicUrl, key } = await requestPresignedUrl({
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        });

        await uploadToOss(file, presignedUrl, (pct) => {
          setState((prev) => ({
            ...prev,
            progress: { ...(prev.progress ?? {}), [uid]: pct },
          }));
        });

        return { url: publicUrl, key };
      } catch (err) {
        // If OSS not configured, return empty URL — caller should fall back
        // to local-only attachment.
        if (
          err instanceof Error &&
          err.message.includes("oss_not_configured")
        ) {
          return { url: "", key: "" };
        }
        throw err;
      } finally {
        // W10: remove this file's progress entry; uploading stays true only
        // while other uploads are still in flight.
        setState((prev) => {
          const nextProgress = { ...(prev.progress ?? {}) };
          delete nextProgress[uid];
          return {
            uploading: Object.keys(nextProgress).length > 0,
            progress: nextProgress,
          };
        });
      }
    },
    [],
  );

  /**
   * Construct a temporary UploadFile entry for immediate UI feedback.
   *
   * For image files, generates a local blob URL so the thumbnail preview
   * shows instantly — even before the OSS upload completes. Without this,
   * antd Image falls back to displaying the alt text (file.name, e.g.
   * "image.png") which looks like a broken image.
   */
  const createUploadFileEntry = useCallback(
    (file: File, uid?: string): UploadFile => {
      const entry: UploadFile = {
        uid: uid ?? `upload_${Date.now()}_${file.name}`,
        name: file.name,
        type: file.type,
        size: file.size,
        status: "uploading",
        originFileObj: file as any,
      };
      if (file.type?.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(file.name ?? "")) {
        try {
          entry.thumbUrl = URL.createObjectURL(file);
        } catch {
          // createObjectURL can fail in sandboxed contexts; non-fatal.
        }
      }
      return entry;
    },
    [],
  );

  return { uploadFile, state, createUploadFileEntry };
}
