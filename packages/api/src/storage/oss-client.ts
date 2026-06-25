import { createHash, createHmac } from "node:crypto";
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

type SignatureVersion = "v1" | "v4";

/**
 * Resolve the OSS signature version. Defaults to V4 (HMAC-SHA256) to retire
 * the deprecated HMAC-SHA1 V1 scheme (C14). Set
 * `SUNPILOT_OSS_SIGNATURE_VERSION=v1` to fall back to the legacy V1 signer.
 */
function resolveSignatureVersion(
  env: NodeJS.ProcessEnv = process.env,
): SignatureVersion {
  return env.SUNPILOT_OSS_SIGNATURE_VERSION === "v1" ? "v1" : "v4";
}

/** Extract the OSS region (e.g. "cn-hangzhou") from an endpoint hostname. */
function extractRegion(endpoint: string): string {
  const normalized = endpoint.replace(/-internal\./i, ".");
  const match = normalized.match(/oss-([a-z0-9-]+)\.aliyuncs\.com/i);
  return match?.[1] ?? "cn-hangzhou";
}

/** RFC 3986-ish URI encoder for canonical query string components. */
function uriEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export class OssClient {
  private readonly config: OssConfig;
  private readonly signatureVersion: SignatureVersion;

  constructor(config: OssConfig, signatureVersion: SignatureVersion = resolveSignatureVersion()) {
    this.config = {
      ...config,
      uploadPrefix:
        config.uploadPrefix ?? "sunpilot/uploads",
      maxFileSizeMb: config.maxFileSizeMb ?? 50,
    };
    this.signatureVersion = signatureVersion;
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
   * Uses OSS V4 (HMAC-SHA256) by default; falls back to V1 (HMAC-SHA1) only
   * when SUNPILOT_OSS_SIGNATURE_VERSION=v1 is set.
   */
  async createPresignedUrl(input: {
    key: string;
    contentType?: string;
    sizeBytes?: number;
  }): Promise<string> {
    const { key, sizeBytes } = input;

    // Validate file size
    const maxMb = this.config.maxFileSizeMb ?? 50;
    if (sizeBytes !== undefined && sizeBytes > maxMb * 1024 * 1024) {
      throw ossFileTooLarge(sizeBytes / (1024 * 1024), maxMb);
    }

    const host = `${this.config.bucket}.${this.config.endpoint}`;
    const expires = 600;

    if (this.signatureVersion === "v4") {
      return this.createV4PresignedPutUrl(host, key, expires);
    }
    return this.createV1PresignedPutUrl(host, key, input.contentType, expires);
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

    let authorization: string;
    let headers: Record<string, string>;
    if (this.signatureVersion === "v4") {
      const v4 = this.signV4Request("DELETE", host, key, {}, "UNSIGNED-PAYLOAD");
      authorization = `OSS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${v4.scope},SignedHeaders=host,Signature=${v4.signature}`;
      headers = { "x-oss-date": v4.isoDate, Authorization: authorization };
    } else {
      const signature = this.signV1Request("DELETE", key, undefined, date);
      authorization = `OSS ${this.config.accessKeyId}:${signature}`;
      headers = { Date: date, Authorization: authorization };
    }

    const response = await fetch(`https://${host}/${key}`, {
      method: "DELETE",
      headers,
    });

    if (!response.ok && response.status !== 204) {
      throw ossDeleteFailed(response.status, response.statusText);
    }
  }

  // ── V4 (HMAC-SHA256) signing ──────────────────────────────────────

  /**
   * Build an OSS V4 presigned PUT URL.
   *
   * Canonical request form for a presigned URL:
   *   PUT\n
   *   <canonicalURI>\n
   *   <canonicalQueryString — all x-oss-* params except signature, sorted>\n
   *   host:<host>\n\n
   *   host\n
   *   UNSIGNED-PAYLOAD
   */
  private createV4PresignedPutUrl(host: string, key: string, expires: number): string {
    const region = extractRegion(this.config.endpoint);
    const now = new Date();
    const isoDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const shortDate = isoDate.slice(0, 8);
    const scope = `${shortDate}/${region}/oss/aliyun_v4_request`;

    const signedParams: Record<string, string> = {
      "x-oss-signature-version": "OSS4-HMAC-SHA256",
      "x-oss-credential": `${this.config.accessKeyId}/${scope}`,
      "x-oss-date": isoDate,
      "x-oss-expires": String(expires),
      "x-oss-signedHeaders": "host",
    };

    const canonicalQueryString = Object.keys(signedParams)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(signedParams[k]!)}`)
      .join("&");

    const canonicalRequest = [
      "PUT",
      `/${uriEncode(key)}`,
      canonicalQueryString,
      `host:${host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [
      "OSS4-HMAC-SHA256",
      isoDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const signature = this.v4Signature(stringToSign, shortDate, region);
    const finalQuery = `${canonicalQueryString}&x-oss-signature=${signature}`;
    return `https://${host}/${key}?${finalQuery}`;
  }

  /**
   * Compute a V4 signature for a direct (non-presigned) request.
   * Returns the scope, ISO date, and hex signature for the Authorization header.
   */
  private signV4Request(
    method: string,
    host: string,
    key: string,
    _extraHeaders: Record<string, string>,
    payloadHash: string,
  ): { scope: string; isoDate: string; signature: string } {
    const region = extractRegion(this.config.endpoint);
    const now = new Date();
    const isoDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const shortDate = isoDate.slice(0, 8);
    const scope = `${shortDate}/${region}/oss/aliyun_v4_request`;

    const canonicalRequest = [
      method,
      `/${uriEncode(key)}`,
      "",
      `host:${host}\n`,
      "host",
      payloadHash,
    ].join("\n");

    const stringToSign = [
      "OSS4-HMAC-SHA256",
      isoDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    return { scope, isoDate, signature: this.v4Signature(stringToSign, shortDate, region) };
  }

  private v4Signature(stringToSign: string, shortDate: string, region: string): string {
    const dateKey = createHmac("sha256", `aliyun_v4${this.config.accessKeySecret}`)
      .update(shortDate)
      .digest();
    const dateRegionKey = createHmac("sha256", dateKey).update(region).digest();
    const dateRegionServiceKey = createHmac("sha256", dateRegionKey).update("oss").digest();
    const signingKey = createHmac("sha256", dateRegionServiceKey)
      .update("aliyun_v4_request")
      .digest();
    return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  }

  // ── V1 (HMAC-SHA1) signing — legacy fallback ──────────────────────

  private createV1PresignedPutUrl(
    host: string,
    key: string,
    contentType: string | undefined,
    expires: number,
  ): string {
    const expiration = Math.floor(Date.now() / 1000) + expires;
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
   * Build and sign an OSS V1 request string using HMAC-SHA1.
   * Retained for backward compatibility when V4 is disabled.
   */
  private signV1Request(
    verb: string,
    key: string,
    contentType?: string,
    date?: string,
  ): string {
    const { bucket, accessKeySecret } = this.config;
    const requestDate = date ?? new Date().toUTCString();
    const contentMd5 = "";
    const resource = `/${bucket}/${key}`;

    const stringToSign = [verb, contentMd5, contentType ?? "", requestDate, resource].join("\n");

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
