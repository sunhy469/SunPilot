import { describe, expect, test } from "vitest";
import { extractMarkdownCards } from "../markdown/extractMarkdownCards";

describe("extractMarkdownCards", () => {
  test("extracts Markdown tables as TableCardData", () => {
    const markdown = `| Name  | Age |
|-------|-----|
| Alice | 30  |
| Bob   | 25  |`;

    const result = extractMarkdownCards(markdown);

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.columns).toEqual([
      { key: "Name", label: "Name" },
      { key: "Age", label: "Age" },
    ]);
    expect(result.tables[0]!.rows).toEqual([
      { Name: "Alice", Age: "30" },
      { Name: "Bob", Age: "25" },
    ]);
  });

  test("extracts consecutive images as image array", () => {
    const markdown = `![Alt 1](https://img1.png)
![Alt 2](https://img2.png)`;

    const result = extractMarkdownCards(markdown);

    expect(result.images).toHaveLength(2);
    expect(result.images[0]).toEqual({
      src: "https://img1.png",
      alt: "Alt 1",
      caption: "Alt 1",
    });
    expect(result.images[1]).toEqual({
      src: "https://img2.png",
      alt: "Alt 2",
      caption: "Alt 2",
    });
  });

  test("extracts task list items as checklist items", () => {
    const markdown = `- [x] Task one
- [ ] Task two
* [x] Task three`;

    const result = extractMarkdownCards(markdown);

    expect(result.checklists).toHaveLength(1);
    expect(result.checklists[0]!.items).toHaveLength(3);
    expect(result.checklists[0]!.items[0]!.checked).toBe(true);
    expect(result.checklists[0]!.items[0]!.label).toBe("Task one");
    expect(result.checklists[0]!.items[1]!.checked).toBe(false);
    expect(result.checklists[0]!.items[1]!.label).toBe("Task two");
    expect(result.checklists[0]!.items[2]!.checked).toBe(true);
    expect(result.checklists[0]!.items[2]!.label).toBe("Task three");
  });

  test("extracts bare URLs as link previews", () => {
    const markdown = `https://example.com
https://another.com`;

    const result = extractMarkdownCards(markdown);

    expect(result.linkPreviews).toHaveLength(2);
    expect(result.linkPreviews[0]).toEqual({ url: "https://example.com" });
    expect(result.linkPreviews[1]).toEqual({ url: "https://another.com" });
  });

  test("extracts fenced code blocks", () => {
    const markdown = `\`\`\`typescript
const x = 1;
console.log(x);
\`\`\``;

    const result = extractMarkdownCards(markdown);

    expect(result.codeBlocks).toHaveLength(1);
    expect(result.codeBlocks[0]!.language).toBe("typescript");
    expect(result.codeBlocks[0]!.code).toBe("const x = 1;\nconsole.log(x);");
  });

  test("returns remaining markdown text", () => {
    const markdown = `Hello world
This is plain text`;

    const result = extractMarkdownCards(markdown);

    expect(result.remainingMarkdown).toBe("Hello world\nThis is plain text");
    expect(result.tables).toHaveLength(0);
    expect(result.images).toHaveLength(0);
  });

  test("handles empty input", () => {
    const result = extractMarkdownCards("");

    expect(result.tables).toHaveLength(0);
    expect(result.images).toHaveLength(0);
    expect(result.checklists).toHaveLength(0);
    expect(result.linkPreviews).toHaveLength(0);
    expect(result.codeBlocks).toHaveLength(0);
    expect(result.remainingMarkdown).toBe("");
  });

  test("handles input with no extractable content", () => {
    const markdown = `Just some regular text
Another line of text`;

    const result = extractMarkdownCards(markdown);

    expect(result.tables).toHaveLength(0);
    expect(result.images).toHaveLength(0);
    expect(result.remainingMarkdown).toBe(markdown);
  });

  test("handles multiple tables separated by text", () => {
    const markdown = `| A | B |
|---|---|
| 1 | 2 |

Some text between

| C | D |
|---|---|
| 3 | 4 |`;

    const result = extractMarkdownCards(markdown);

    expect(result.tables).toHaveLength(2);
    expect(result.remainingMarkdown).toContain("Some text between");
  });

  test("handles mixed content (table + images + text)", () => {
    const markdown = `Intro text

| Col1 | Col2 |
|------|------|
| a    | b    |

![Image](https://img.png)

Outro text`;

    const result = extractMarkdownCards(markdown);

    expect(result.tables).toHaveLength(1);
    expect(result.images).toHaveLength(1);
    expect(result.remainingMarkdown).toContain("Intro text");
    expect(result.remainingMarkdown).toContain("Outro text");
  });

  test("extracts sunpilot-card DSL blocks as RichCardView", () => {
    const markdown = `\`\`\`sunpilot-card
{
  "type": "checklist",
  "title": "请确认订单信息",
  "data": {
    "items": [
      { "id": "sku", "label": "SKU 已确认", "required": true }
    ],
    "mode": "submit"
  }
}
\`\`\``;

    const result = extractMarkdownCards(markdown);

    expect(result.cardDslCards).toHaveLength(1);
    expect(result.cardDslCards[0]!.type).toBe("checklist");
    expect(result.cardDslCards[0]!.title).toBe("请确认订单信息");
    expect(result.cardDslCards[0]!.data).toEqual({
      items: [{ id: "sku", label: "SKU 已确认", required: true }],
      mode: "submit",
    });
    expect(result.remainingMarkdown).toBe("");
  });

  test("falls back to code block for invalid sunpilot-card DSL", () => {
    const markdown = `\`\`\`sunpilot-card
this is not valid json
\`\`\``;

    const result = extractMarkdownCards(markdown);

    expect(result.cardDslCards).toHaveLength(0);
    expect(result.codeBlocks).toHaveLength(1);
    expect(result.codeBlocks[0]!.language).toBe("sunpilot-card");
    expect(result.codeBlocks[0]!.code).toBe("this is not valid json");
  });

  test("falls back to code block for sunpilot-card DSL missing type or data", () => {
    const markdown = `\`\`\`sunpilot-card
{ "title": "No type or data" }
\`\`\``;

    const result = extractMarkdownCards(markdown);

    expect(result.cardDslCards).toHaveLength(0);
    expect(result.codeBlocks).toHaveLength(1);
  });

  test("generates id for sunpilot-card DSL without id", () => {
    const markdown = `\`\`\`sunpilot-card
{ "type": "info", "data": { "text": "hello" } }
\`\`\``;

    const result = extractMarkdownCards(markdown);

    expect(result.cardDslCards).toHaveLength(1);
    expect(result.cardDslCards[0]!.id).toMatch(/^dsl_info_/);
  });

  test("preserves id from sunpilot-card DSL", () => {
    const markdown = `\`\`\`sunpilot-card
{ "id": "my_card_1", "type": "metric", "data": { "metrics": [] } }
\`\`\``;

    const result = extractMarkdownCards(markdown);

    expect(result.cardDslCards).toHaveLength(1);
    expect(result.cardDslCards[0]!.id).toBe("my_card_1");
  });
});
