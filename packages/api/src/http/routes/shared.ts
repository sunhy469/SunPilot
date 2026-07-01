import type { ZodError } from "zod";

/** Format Zod validation errors into a single string for API error responses. */
export function formatZodIssues(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/** Encode pagination cursor as base64url. */
export function paginationCursor(input: {
  pinned?: boolean;
  updatedAt: string;
  id: string;
}): string {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}
