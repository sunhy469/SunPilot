import { describe, expect, it } from "vitest";
import type { UploadFile } from "antd/es/upload";
import type { AttachmentRef } from "./types";
import {
  uploadFileToAttachmentRef,
  validateAttachmentsForSend,
  validateAttachmentRefsForSend,
} from "./attachment-utils";

function imageFile(overrides: Partial<UploadFile> = {}): UploadFile {
  return {
    uid: "image-1",
    name: "image.png",
    type: "image/png",
    status: "done",
    ...overrides,
  };
}

describe("attachment OSS URL gating", () => {
  it("accepts an uploaded image with a public OSS URL", () => {
    const file = imageFile({
      url: "https://example.oss-cn-shanghai.aliyuncs.com/image.png",
      response: { key: "uploads/image.png" },
    });

    expect(validateAttachmentsForSend([file])).toEqual({
      missingImageRef: false,
      hasUploading: false,
      hasError: false,
    });
    expect(uploadFileToAttachmentRef(file)).toMatchObject({
      url: file.url,
      storageKey: "uploads/image.png",
    });
  });

  it("rejects a UI image that only has a legacy data URL", () => {
    const file = imageFile({ response: { dataUrl: "data:image/png;base64,abc" } });

    expect(validateAttachmentsForSend([file]).missingImageRef).toBe(true);
    expect(uploadFileToAttachmentRef(file).dataUrl).toBeUndefined();
  });

  it("reports images that are still uploading", () => {
    const file = imageFile({ status: "uploading" });

    expect(validateAttachmentsForSend([file])).toEqual({
      missingImageRef: true,
      hasUploading: true,
      hasError: false,
    });
  });

  it("blocks sending when any OSS upload failed", () => {
    const file: UploadFile = {
      uid: "document-1",
      name: "document.pdf",
      type: "application/pdf",
      status: "error",
    };

    expect(validateAttachmentsForSend([file])).toEqual({
      missingImageRef: false,
      hasUploading: false,
      hasError: true,
    });
  });

  it.each([
    { storageKey: "uploads/image.png" },
    { dataUrl: "data:image/png;base64,abc" },
  ] satisfies Partial<AttachmentRef>[])(
    "rejects a final image reference without a public URL: %o",
    (partial) => {
      const ref: AttachmentRef = {
        id: "image-1",
        name: "image.png",
        type: "image/png",
        ...partial,
      };

      expect(validateAttachmentRefsForSend([ref])).toEqual({
        ready: false,
        missingImageRef: true,
      });
    },
  );
});
