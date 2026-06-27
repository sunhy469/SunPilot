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
   * Construct an UploadFile entry while OSS upload is in progress.
   * The UI intentionally waits for the public OSS URL before rendering
   * image content, so no browser-local blob preview is created here.
   */
  const createUploadFileEntry = useCallback(
    (file: File, uid?: string): UploadFile => {
      return {
        uid: uid ?? `upload_${Date.now()}_${file.name}`,
        name: file.name,
        type: file.type,
        size: file.size,
        status: "uploading",
        originFileObj: file as any,
      };
    },
    [],
  );

  return { uploadFile, state, createUploadFileEntry };
}
