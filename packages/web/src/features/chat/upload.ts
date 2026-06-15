import { createRequest } from "../../shared/api/client";

/**
 * OSS upload helpers for the web client.
 *
 * Flow: ChatComposer → requestPresignedUrl → fetch PUT to OSS → return URL/key
 */

export interface PresignRequest {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface PresignResponse {
  presignedUrl: string;
  publicUrl: string;
  key: string;
}

const request = createRequest();

/**
 * Request a presigned upload URL from the daemon API.
 * Reuses the shared API client for consistent error handling.
 */
export async function requestPresignedUrl(
  input: PresignRequest,
): Promise<PresignResponse> {
  return request<PresignResponse>("/v1/upload/presign", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Upload a file to OSS using a presigned URL.
 * Sends the Content-Type header to match the OSS signature.
 * Uses XMLHttpRequest to support progress tracking.
 */
export function uploadToOss(
  file: File,
  presignedUrl: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", presignedUrl);

    // MUST set Content-Type to match the value used in OSS signature.
    // OSS validates the actual request headers against the signature string.
    if (file.type) {
      xhr.setRequestHeader("Content-Type", file.type);
    }

    if (onProgress) {
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
    }

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Upload network error")));
    xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));

    xhr.send(file);
  });
}
