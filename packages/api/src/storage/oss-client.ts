import { createHmac } from "node:crypto";
import { ossFileTooLarge, ossDeleteFailed } from "@sunpilot/core";

// ── Configuration ──────────────────────────────────────────────────────

export interface OssConfig {
  provider: "aliyun-oss";
  endpoint: string;
  bucket: string;
  publicBaseUrl: string;
  accessKeyId: string;
  accessKeySecret: string;
  uploadPrefix?: string;
  maxFileSizeMb?: number;
}

export interface PresignResult {
  presignedUrl: string;
  publicUrl: string;
  key: string;
}

export class OssClient {
  private readonly config: OssConfig;

  constructor(config: OssConfig) {
    this.config = {
      ...config,
      uploadPrefix:
        config.uploadPrefix ?? "sunpilot/uploads",
      maxFileSizeMb: config.maxFileSizeMb ?? 50,
    };
  }

  /**
   * Create a unique OSS object key for the given file name.
   * Prevents path injection and naming collisions by prefixing with
   * a date-based path and prepending a random suffix.
   */
  createObjectKey(fileName: string): string {
    const safeName = fileName.replace(/[\\/:*?"<>|]/g, "_");
    const datePath = new Date()
      .toISOString()
      .replace(/[T:]/g, "-")
      .slice(0, 19);
    const random = Math.random().toString(36).slice(2, 8);
    return `${this.config.uploadPrefix}/${datePath}/${random}_${safeName}`;
  }

  /**
   * Create a presigned PUT URL for uploading an object directly to OSS.
   * The URL is valid for 10 minutes.
   *
   * OSS presigned URL signature format:
   *   StringToSign = VERB\nContent-MD5\nContent-Type\nExpires\nResource
   * where Expires is a Unix timestamp (seconds since epoch).
   */
  async createPresignedUrl(input: {
    key: string;
    contentType?: string;
    sizeBytes?: number;
  }): Promise<string> {
    const { key, contentType, sizeBytes } = input;

    // Validate file size
    const maxMb = this.config.maxFileSizeMb ?? 50;
    if (sizeBytes !== undefined && sizeBytes > maxMb * 1024 * 1024) {
      throw ossFileTooLarge(sizeBytes / (1024 * 1024), maxMb);
    }

    const host = `${this.config.bucket}.${this.config.endpoint}`;
    const expires = 600;
    const expiration = Math.floor(Date.now() / 1000) + expires;

    // Build signature with Expires (Unix timestamp) in the 4th field
    const contentMd5 = "";
    const resource = `/${this.config.bucket}/${key}`;
    const stringToSign = [
      "PUT",
      contentMd5,
      contentType ?? "",
      String(expiration),
      resource,
    ].join("\n");

    const signature = createHmac("sha1", this.config.accessKeySecret)
      .update(stringToSign)
      .digest("base64");

    const params = new URLSearchParams({
      OSSAccessKeyId: this.config.accessKeyId,
      Expires: String(expiration),
      Signature: signature,
    });

    return `https://${host}/${key}?${params.toString()}`;
  }

  /**
   * Return the public-facing URL for an object key.
   */
  publicUrl(key: string): string {
    const base = this.config.publicBaseUrl.replace(/\/+$/, "");
    return `${base}/${key}`;
  }

  /**
   * Delete an object from OSS using a signed DELETE request.
   */
  async delete(key: string): Promise<void> {
    const host = `${this.config.bucket}.${this.config.endpoint}`;
    const date = new Date().toUTCString();
    const signature = this.signRequest("DELETE", key);

    const response = await fetch(`https://${host}/${key}`, {
      method: "DELETE",
      headers: {
        Date: date,
        Authorization: `OSS ${this.config.accessKeyId}:${signature}`,
      },
    });

    if (!response.ok && response.status !== 204) {
      throw ossDeleteFailed(response.status, response.statusText);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Build and sign an OSS request string using HMAC-SHA1.
   * Produces the base64-encoded signature shared by presigned URLs
   * and direct API calls (DELETE, etc.).
   */
  private signRequest(
    verb: string,
    key: string,
    contentType?: string,
  ): string {
    const { bucket, accessKeySecret } = this.config;
    const date = new Date().toUTCString();
    const contentMd5 = "";
    const resource = `/${bucket}/${key}`;

    const stringToSign = [verb, contentMd5, contentType ?? "", date, resource].join("\n");

    return createHmac("sha1", accessKeySecret)
      .update(stringToSign)
      .digest("base64");
  }
}

/**
 * Create an OssClient from environment variables.
 * Reads non-sensitive configuration (endpoint, bucket, publicBaseUrl)
 * from env vars, consistent with the project's security policy that
 * secrets must never be stored in the repository.
 */
export function createOssClient(): OssClient | null {
  const endpoint = process.env["ALIYUN_OSS_ENDPOINT"];
  const bucket = process.env["ALIYUN_OSS_BUCKET_NAME"];
  const publicBaseUrl = process.env["ALIYUN_OSS_PUBLIC_BASE_URL"];
  const accessKeyId = process.env["ALIYUN_OSS_ACCESS_KEY_ID"];
  const accessKeySecret = process.env["ALIYUN_OSS_ACCESS_KEY_SECRET"];

  if (!endpoint || !bucket || !publicBaseUrl || !accessKeyId || !accessKeySecret) {
    return null;
  }

  return new OssClient({
    provider: "aliyun-oss",
    endpoint,
    bucket,
    publicBaseUrl,
    accessKeyId,
    accessKeySecret,
  });
}
