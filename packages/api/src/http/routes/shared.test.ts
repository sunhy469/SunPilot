import { describe, expect, test } from "vitest";
import { z } from "zod";
import { formatZodIssues, paginationCursor } from "./shared.js";

describe("formatZodIssues", () => {
  test("formats a single issue as path: message", () => {
    const schema = z.object({ name: z.string().min(1) });
    try {
      schema.parse({ name: "" });
      throw new Error("should have thrown");
    } catch (err) {
      const formatted = formatZodIssues(err as z.ZodError);
      expect(formatted).toBe("name: String must contain at least 1 character(s)");
    }
  });

  test("joins multiple issues with semicolons", () => {
    const schema = z.object({
      name: z.string().min(1),
      email: z.string().min(1),
    });
    try {
      schema.parse({ name: "", email: "" });
      throw new Error("should have thrown");
    } catch (err) {
      const formatted = formatZodIssues(err as z.ZodError);
      expect(formatted).toContain("name:");
      expect(formatted).toContain("email:");
      expect(formatted).toContain("; ");
    }
  });

  test("handles nested path (object property)", () => {
    const schema = z.object({
      user: z.object({ age: z.number().min(0) }),
    });
    try {
      schema.parse({ user: { age: -1 } });
      throw new Error("should have thrown");
    } catch (err) {
      const formatted = formatZodIssues(err as z.ZodError);
      expect(formatted).toContain("user.age");
    }
  });
});

describe("paginationCursor", () => {
  test("encodes updatedAt and id as base64url JSON", () => {
    const cursor = paginationCursor({
      updatedAt: "2026-06-29T00:00:00.000Z",
      id: "msg_1",
    });
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({
      updatedAt: "2026-06-29T00:00:00.000Z",
      id: "msg_1",
    });
  });

  test("produces stable output for same input", () => {
    const input = { updatedAt: "2026-06-29T00:00:00.000Z", id: "msg_1" };
    expect(paginationCursor(input)).toBe(paginationCursor(input));
  });

  test("produces different output for different input", () => {
    const a = paginationCursor({ updatedAt: "2026-06-29T00:00:00.000Z", id: "a" });
    const b = paginationCursor({ updatedAt: "2026-06-29T00:00:00.000Z", id: "b" });
    expect(a).not.toBe(b);
  });

  test("includes pinned when provided", () => {
    const cursor = paginationCursor({
      pinned: true,
      updatedAt: "2026-06-29T00:00:00.000Z",
      id: "conv_1",
    });
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({
      pinned: true,
      updatedAt: "2026-06-29T00:00:00.000Z",
      id: "conv_1",
    });
  });

  test("omits pinned when not provided (runs cursor)", () => {
    const cursor = paginationCursor({
      updatedAt: "2026-06-29T00:00:00.000Z",
      id: "run_1",
    });
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    expect(decoded).not.toHaveProperty("pinned");
  });
});
