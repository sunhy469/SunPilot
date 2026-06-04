export class RuntimeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export function notFound(message: string): RuntimeError {
  return new RuntimeError(message, 404, "not_found");
}

export function conflict(message: string): RuntimeError {
  return new RuntimeError(message, 409, "conflict");
}
