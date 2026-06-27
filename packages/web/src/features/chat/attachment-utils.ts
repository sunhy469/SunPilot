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
 *
 * The send gates below separately require public OSS URLs for images.
 */
export function uploadFilesToAttachmentRefs(
  files: UploadFile[],
): AttachmentRef[] {
  return files
    .filter((f) => f.status !== "uploading" && f.status !== "error")
    .map(uploadFileToAttachmentRef);
}

/**
 * Validate attachments before sending.
 *
 * §Phase 2b send gate:
 * - Returns missingImageRef: true when image/* files lack a public OSS URL.
 * - Returns hasUploading: true when files are still uploading.
 * - Returns hasError: true when any OSS upload failed.
 *
 * These conditions should block the send or queue it until uploads complete.
 */
export function validateAttachmentsForSend(files: UploadFile[]): {
  /** Any image/* file lacks a public OSS URL. */
  missingImageRef: boolean;
  /** Some files are still uploading. */
  hasUploading: boolean;
  /** Some files failed to upload to OSS. */
  hasError: boolean;
} {
  const hasUploading = files.some((f) => f.status === "uploading");
  const hasError = files.some((f) => f.status === "error");
  const imageFiles = files.filter(
    (f) =>
      f.type?.startsWith("image/") ||
      /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name),
  );
  const missingImageRef =
    imageFiles.length > 0 &&
    imageFiles.some((f) => !f.url);
  return { missingImageRef, hasUploading, hasError };
}

/** Image file type check used by both UploadFile and AttachmentRef validation layers. */
export function isImageType(file: { type?: string; name?: string }): boolean {
  return (
    (file.type?.startsWith("image/") ?? false) ||
    /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(file.name ?? "")
  );
}

/**
 * §5.2 final gate: Validate AttachmentRef[] before sending.
 *
 * Unlike validateAttachmentsForSend (which operates on antd UploadFile[] UI state),
 * this function checks the final AttachmentRef[] — the actual data that will be
 * serialized over WebSocket. This prevents the "UI shows image but backend gets
 * nothing" illusion when the UploadFile→AttachmentRef conversion drops fields.
 *
 * Returns true when all image attachments have a public OSS URL.
 */
export function validateAttachmentRefsForSend(refs: AttachmentRef[]): {
  /** All image attachments are ready to send (have a public OSS URL). */
  ready: boolean;
  /** Some image files still lack a usable reference. */
  missingImageRef: boolean;
} {
  const imageAttachments = refs.filter(isImageType);
  if (imageAttachments.length === 0) {
    return { ready: true, missingImageRef: false };
  }
  const missingImageRef = imageAttachments.some((a) => !a.url);
  return { ready: !missingImageRef, missingImageRef };
}
