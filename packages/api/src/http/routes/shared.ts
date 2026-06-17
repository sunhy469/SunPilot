import type { ZodError } from "zod";

/** Format Zod validation errors into a single string for API error responses. */
export function formatZodIssues(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/** Encode pagination cursor as base64url. */
export function paginationCursor(input: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({ updatedAt: input.updatedAt, id: input.id })).toString("base64url");
}
