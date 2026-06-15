export class RuntimeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export function notFound(message: string): RuntimeError {
  return new RuntimeError(message, 404, "not_found");
}

export function ossFileTooLarge(currentMb: number, maxMb: number): RuntimeError {
  return new RuntimeError(
    `File size ${currentMb.toFixed(1)}MB exceeds limit of ${maxMb}MB`,
    413,
    "OSS_FILE_TOO_LARGE",
  );
}

export function ossDeleteFailed(status: number, statusText: string): RuntimeError {
  return new RuntimeError(
    `OSS delete failed: ${status} ${statusText}`,
    status,
    "OSS_DELETE_FAILED",
  );
}

export function ossNotConfigured(): RuntimeError {
  return new RuntimeError(
    "OSS is not configured. Set ALIYUN_OSS_* environment variables to enable file uploads.",
    501,
    "oss_not_configured",
  );
}
