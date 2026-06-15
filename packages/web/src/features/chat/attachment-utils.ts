import type { UploadFile } from "antd/es/upload";
import type { AttachmentRef } from "./types";

/**
 * Convert an antd UploadFile to the AttachmentRef protocol format.
 *
 * Extracts OSS metadata (url, storageKey) from the upload response
 * so the backend can retrieve or reference the uploaded file.
 */
export function uploadFileToAttachmentRef(file: UploadFile): AttachmentRef {
  const response = file.response as { key?: string } | undefined;
  return {
    id: file.uid,
    name: file.name,
    type: file.type ?? "application/octet-stream",
    sizeBytes: file.size,
    url: file.url,
    storageKey: response?.key,
    provider: "aliyun-oss",
  };
}

/**
 * Batch-convert antd UploadFile[] to AttachmentRef[].
 * Filters out files still in uploading/error state.
 */
export function uploadFilesToAttachmentRefs(
  files: UploadFile[],
): AttachmentRef[] {
  return files
    .filter((f) => f.status !== "uploading" && f.status !== "error")
    .map(uploadFileToAttachmentRef);
}
