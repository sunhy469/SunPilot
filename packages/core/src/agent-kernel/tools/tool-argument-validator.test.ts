import { describe, expect, test } from "vitest";
import { validateToolArguments } from "./tool-argument-validator.js";

describe("validateToolArguments", () => {
  test("validates nested types, enums, arrays, and additional properties", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["mode", "items", "options"],
      properties: {
        mode: { type: "string", enum: ["safe", "fast"] },
        items: {
          type: "array",
          minItems: 1,
          items: { type: "integer", minimum: 1 },
        },
        options: {
          type: "object",
          additionalProperties: false,
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
      },
    };

    expect(validateToolArguments({
      mode: "safe",
      items: [1, 2],
      options: { enabled: true },
    }, schema)).toEqual([]);

    const errors = validateToolArguments({
      mode: "unsafe",
      items: [0, 1.5],
      options: { enabled: "yes", extra: true },
      unexpected: true,
    }, schema);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("allowed values"),
      expect.stringContaining("at least 1"),
      expect.stringContaining("integer"),
      expect.stringContaining("boolean"),
      "Unexpected field: extra",
      "Unexpected field: unexpected",
    ]));
  });

  test("supports anyOf and oneOf required branches", () => {
    expect(validateToolArguments({ imageUrl: "https://example.test/a.png" }, {
      type: "object",
      anyOf: [
        { required: ["imageUrl"] },
        { required: ["imageDataUrl"] },
      ],
    })).toEqual([]);
    expect(validateToolArguments({}, {
      type: "object",
      anyOf: [
        { required: ["imageUrl"] },
        { required: ["imageDataUrl"] },
      ],
    })).toEqual([expect.stringContaining("does not satisfy any")]);
    expect(validateToolArguments({ a: true, b: true }, {
      type: "object",
      oneOf: [{ required: ["a"] }, { required: ["b"] }],
    })).toEqual([expect.stringContaining("exactly one")]);
  });
});
