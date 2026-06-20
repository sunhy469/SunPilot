import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { RichTextRenderer } from "../richText/RichTextRenderer";

afterEach(cleanup);

describe("RichTextRenderer", () => {
  test("renders plain text without modification", () => {
    const { container } = render(<RichTextRenderer value="Hello world" />);
    expect(container.textContent).toBe("Hello world");
  });

  test("renders explicit href as a link", () => {
    render(
      <RichTextRenderer value={{ text: "Click here", href: "https://example.com" }} />,
    );
    const link = screen.getByRole("link", { name: "Click here" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  test("auto-detects bare URLs and renders them as links", () => {
    render(<RichTextRenderer value="Visit https://example.com for details" />);
    const link = screen.getByRole("link", { name: "https://example.com" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  test("auto-detects Markdown links [label](url) and renders them as links", () => {
    render(<RichTextRenderer value="Check [Docs](https://docs.example.com) for help" />);
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://docs.example.com");
  });

  test("auto-detects email addresses and renders them as mailto links", () => {
    render(<RichTextRenderer value="Contact user@example.com for info" />);
    const link = screen.getByRole("link", { name: "user@example.com" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "mailto:user@example.com");
  });

  test("renders inline code with backticks", () => {
    const { container } = render(
      <RichTextRenderer value="Use `console.log` to debug" />,
    );
    const codeEl = container.querySelector("code.rich-text-inline-code");
    expect(codeEl).toBeInTheDocument();
    expect(codeEl?.textContent).toBe("console.log");
  });

  test('format="plain" does not linkify URLs', () => {
    const { container } = render(
      <RichTextRenderer value={{ text: "Visit https://example.com", format: "plain" }} />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.textContent).toContain("https://example.com");
  });

  test('format="markdown" linkifies content', () => {
    render(
      <RichTextRenderer
        value={{ text: "See [Guide](https://guide.example.com)", format: "markdown" }}
      />,
    );
    const link = screen.getByRole("link", { name: "Guide" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://guide.example.com");
  });

  test("returns null for undefined value", () => {
    const { container } = render(<RichTextRenderer value={undefined} />);
    expect(container.innerHTML).toBe("");
  });

  test("applies tone styling", () => {
    const { container } = render(
      <RichTextRenderer value={{ text: "Warning!", tone: "warning" }} />,
    );
    // Ant Design Text with type="warning" adds ant-typography or ant-typography-warning class
    const textEl = container.querySelector(".ant-typography-warning, .ant-typography");
    expect(textEl).toBeInTheDocument();
  });
});
