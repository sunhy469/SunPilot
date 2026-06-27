import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OssClient } from "./oss-client.js";

const config = {
  provider: "aliyun-oss" as const,
  endpoint: "oss-cn-shanghai.aliyuncs.com",
  bucket: "jadeco",
  publicBaseUrl: "https://jadeco.oss-cn-shanghai.aliyuncs.com",
  accessKeyId: "test-access-key",
  accessKeySecret: "test-access-secret",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("OssClient V4 presigned PUT", () => {
  test("preserves path separators and uses OSS additional headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T09:53:56.000Z"));
    const client = new OssClient(config, "v4");

    const signed = await client.createPresignedUrl({
      key: "sunpilot/uploads/2026-06-27/image one.png",
      contentType: "image/png",
    });
    const url = new URL(signed);

    expect(url.pathname).toBe(
      "/sunpilot/uploads/2026-06-27/image%20one.png",
    );
    expect(url.pathname).not.toContain("%2F");
    expect(url.searchParams.get("x-oss-additional-headers")).toBe("host");
    expect(url.searchParams.has("x-oss-signedHeaders")).toBe(false);
    expect(url.searchParams.get("x-oss-signature")).toBe(
      expectedSignature(url, "image/png"),
    );
  });

  test("binds Content-Type to the signature", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T09:53:56.000Z"));
    const client = new OssClient(config, "v4");
    const key = "sunpilot/uploads/image.png";

    const png = new URL(
      await client.createPresignedUrl({ key, contentType: "image/png" }),
    );
    const jpeg = new URL(
      await client.createPresignedUrl({ key, contentType: "image/jpeg" }),
    );

    expect(png.searchParams.get("x-oss-signature")).not.toBe(
      jpeg.searchParams.get("x-oss-signature"),
    );
    expect(png.searchParams.get("x-oss-signature")).toBe(
      expectedSignature(png, "image/png"),
    );
  });
});

function expectedSignature(url: URL, contentType: string): string {
  const params = [...url.searchParams.entries()]
    .filter(([key]) => key !== "x-oss-signature")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
  const canonicalRequest = [
    "PUT",
    `/jadeco${url.pathname}`,
    params,
    `content-type:${contentType}\nhost:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const isoDate = url.searchParams.get("x-oss-date")!;
  const shortDate = isoDate.slice(0, 8);
  const scope = `${shortDate}/cn-shanghai/oss/aliyun_v4_request`;
  const stringToSign = [
    "OSS4-HMAC-SHA256",
    isoDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const dateKey = hmac(`aliyun_v4${config.accessKeySecret}`, shortDate);
  const regionKey = hmac(dateKey, "cn-shanghai");
  const serviceKey = hmac(regionKey, "oss");
  const signingKey = hmac(serviceKey, "aliyun_v4_request");
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
