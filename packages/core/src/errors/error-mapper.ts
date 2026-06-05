import { CoreError } from "./core-error.js";
import { RuntimeError } from "./runtime-error.js";

export interface ErrorResponse {
  statusCode: number;
  code: string;
  message: string;
}

export function mapCoreError(error: unknown): ErrorResponse {
  if (error instanceof RuntimeError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message
    };
  }
  if (error instanceof CoreError) {
    return {
      statusCode: 500,
      code: error.code,
      message: error.message
    };
  }
  return {
    statusCode: 500,
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error)
  };
}
