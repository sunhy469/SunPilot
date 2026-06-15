import { useCallback, useState } from "react";
import type { UploadFile } from "antd/es/upload";
import { requestPresignedUrl, uploadToOss } from "../../../features/chat/upload";

export interface OssUploadState {
  /** Whether an upload is currently in progress. */
  uploading: boolean;
  /** Upload progress percentage (0-100), undefined when idle. */
  progress?: number;
}

/**
 * Hook that encapsulates the OSS presign → upload flow.
 */
export function useOssUpload() {
  const [state, setState] = useState<OssUploadState>({ uploading: false });

  const updateState = useCallback((patch: Partial<OssUploadState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const uploadFile = useCallback(
    async (file: File): Promise<{ url: string; key: string }> => {
      updateState({ uploading: true, progress: 0 });

      try {
        const { presignedUrl, publicUrl, key } = await requestPresignedUrl({
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        });

        await uploadToOss(file, presignedUrl, (pct) => {
          updateState({ progress: pct });
        });

        updateState({ uploading: false, progress: undefined });
        return { url: publicUrl, key };
      } catch (err) {
        updateState({ uploading: false, progress: undefined });

        // If OSS not configured, return empty URL — caller should fall back
        // to local-only attachment.
        if (
          err instanceof Error &&
          err.message.includes("oss_not_configured")
        ) {
          return { url: "", key: "" };
        }
        throw err;
      }
    },
    [updateState],
  );

  /** Construct a temporary UploadFile entry for immediate UI feedback. */
  const createUploadFileEntry = useCallback(
    (file: File, uid?: string): UploadFile => ({
      uid: uid ?? `upload_${Date.now()}_${file.name}`,
      name: file.name,
      type: file.type,
      size: file.size,
      status: "uploading",
      originFileObj: file as any,
    }),
    [],
  );

  return { uploadFile, state, createUploadFileEntry };
}
