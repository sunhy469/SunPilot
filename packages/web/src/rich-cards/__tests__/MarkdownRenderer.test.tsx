import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MarkdownRenderer } from "../MarkdownRenderer";

afterEach(cleanup);

/**
 * 验证 Streamdown 作为主展示通道：
 * Markdown 表格、列表、代码块、任务列表、链接等由 MarkdownRenderer 直接渲染，
 * 不再被抽取为 rich-card。
 */
describe("MarkdownRenderer — Streamdown 主展示通道", () => {
  test("renders Markdown tables inline (not extracted to TableCard)", () => {
    const markdown = `下面是分析结果：

| 商品 | 价格 | 备注 |
| --- | ---: | --- |
| A | 10 | 引流款 |
| B | 18 | 利润款 |

建议优先测试 B。`;

    const { container } = render(<MarkdownRenderer content={markdown} />);

    // 表格应在 Markdown 渲染结果中存在
    const table = container.querySelector("table");
    expect(table).toBeInTheDocument();

    // 表格内容应完整
    expect(screen.getByText("引流款")).toBeInTheDocument();
    expect(screen.getByText("利润款")).toBeInTheDocument();
  });

  test("renders Markdown bullet lists inline (not extracted to BulletListCard)", () => {
    const markdown = `要点如下：

- 第一项
- 第二项
- 第三项`;

    const { container } = render(<MarkdownRenderer content={markdown} />);

    const listItems = container.querySelectorAll("li");
    expect(listItems.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("第一项")).toBeInTheDocument();
    expect(screen.getByText("第二项")).toBeInTheDocument();
    expect(screen.getByText("第三项")).toBeInTheDocument();
  });

  test("renders Markdown ordered lists inline", () => {
    const markdown = `步骤如下：

1. 第一步
2. 第二步
3. 第三步`;

    const { container } = render(<MarkdownRenderer content={markdown} />);

    const list = container.querySelector("ol");
    expect(list).toBeInTheDocument();
    expect(screen.getByText("第一步")).toBeInTheDocument();
  });

  test("renders fenced code blocks inline (not extracted to CodeBlockWidget)", () => {
    const markdown = "示例代码：\n\n```python\nprint('hello')\n```";

    const { container } = render(<MarkdownRenderer content={markdown} />);

    // 代码块应在 Markdown 渲染结果中存在
    const codeBlock = container.querySelector("pre");
    expect(codeBlock).toBeInTheDocument();
    // 语言类名应包含 python
    const langCode = container.querySelector("code.language-python");
    expect(langCode).toBeInTheDocument();
  });

  test("renders Markdown task lists inline (not extracted to ChecklistCard)", () => {
    const markdown = `待办事项：

- [x] 已完成项
- [ ] 未完成项`;

    const { container } = render(<MarkdownRenderer content={markdown} />);

    // 任务列表应在 Markdown 渲染结果中存在（Streamdown 渲染为 li 元素）
    const listItems = container.querySelectorAll("li");
    expect(listItems.length).toBeGreaterThanOrEqual(2);
    // 已完成项文本应存在
    expect(screen.getByText(/已完成项/)).toBeInTheDocument();
    expect(screen.getByText(/未完成项/)).toBeInTheDocument();
  });

  test("renders Markdown links inline (not extracted to FileLinkWidget)", () => {
    const markdown = "参考文档：[官方文档](https://example.com)";

    render(<MarkdownRenderer content={markdown} />);

    const link = screen.getByRole("link", { name: "官方文档" });
    expect(link).toBeInTheDocument();
    // Streamdown may normalize the URL (trailing slash)
    expect(link.getAttribute("href")).toMatch(/^https:\/\/example\.com\/?$/);
  });

  test("renders Markdown blockquotes inline", () => {
    const markdown = "> 这是一段引用文本";

    const { container } = render(<MarkdownRenderer content={markdown} />);

    const blockquote = container.querySelector("blockquote");
    expect(blockquote).toBeInTheDocument();
  });

  test("renders mixed Markdown content without extraction", () => {
    const markdown = `## 分析结果

| 项目 | 状态 |
| --- | --- |
| A | 完成 |

要点：
- 速度快
- 成本低

\`\`\`json
{"result": "ok"}
\`\`\`

> 总结：表现优秀`;

    const { container } = render(<MarkdownRenderer content={markdown} />);

    // 所有元素都应在同一个 Markdown 渲染中
    expect(container.querySelector("table")).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeInTheDocument();
    expect(container.querySelector("blockquote")).toBeInTheDocument();
    expect(screen.getByText("速度快")).toBeInTheDocument();
  });

  test("returns null for empty content", () => {
    const { container } = render(<MarkdownRenderer content="" />);
    expect(container.innerHTML).toBe("");
  });

  test("renders minimal whitespace content without crash", () => {
    // Even if MarkdownRenderer renders whitespace content,
    // it should not crash or produce rich-card elements
    const { container } = render(<MarkdownRenderer content="   \n  " />);
    // No rich-card wrappers should be present
    expect(container.querySelector(".rich-card-wrapper")).toBeNull();
    expect(container.querySelector('[data-card-type]')).toBeNull();
  });
});
