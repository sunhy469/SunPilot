import { memo, useCallback, useMemo, type ComponentProps, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import type { Components } from "streamdown";
import { Button, message, Typography } from "antd";
import {
  CheckCircleFilled,
  CopyOutlined,
  DownOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { useState } from "react";

const { Text } = Typography;

// ── Inline Code ──────────────────────────────────────────────────────
function InlineCode({ children, ...props }: ComponentProps<"code">) {
  return (
    <code className="md-inline-code" {...props}>
      {children}
    </code>
  );
}

// ── Code Block Header (language label + copy button) ─────────────────
function CodeBlockHeader({
  language,
  code,
}: {
  language?: string;
  code: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      message.success("代码已复制");
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className="md-code-header">
      <Text className="md-code-lang">{language || "code"}</Text>
      <Button
        type="text"
        size="small"
        icon={<CopyOutlined />}
        onClick={handleCopy}
        className="md-code-copy-btn"
      >
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

// ── Code Block (with collapse for long blocks) ────────────────────────
function CodeBlock({
  children,
  className,
  ...props
}: {
  children?: ReactNode;
  className?: string;
  [key: string]: unknown;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Extract code content and language from children
  const { codeStr, language } = useMemo(() => {
    if (!children) return { codeStr: "", language: undefined };

    // Streamdown passes the code content as children
    let text = "";
    if (typeof children === "string") {
      text = children;
    }

    // Try to extract language from className
    const langMatch = className?.match(/language-(\w+)/);
    const lang = langMatch?.[1];

    return { codeStr: text, language: lang };
  }, [children, className]);

  const isLong = codeStr.split("\n").length > 20;

  return (
    <div className="md-code-block">
      <CodeBlockHeader language={language} code={codeStr} />
      <pre
        className={`md-code-pre ${collapsed ? "md-code-collapsed" : ""}`}
      >
        <code className={className}>{children}</code>
      </pre>
      {isLong && (
        <Button
          type="text"
          size="small"
          icon={collapsed ? <DownOutlined /> : <UpOutlined />}
          onClick={() => setCollapsed(!collapsed)}
          className="md-code-collapse-btn"
        >
          {collapsed ? "展开代码" : "收起代码"}
        </Button>
      )}
    </div>
  );
}

// ── Blockquote ────────────────────────────────────────────────────────
function BlockQuote({ children, ...props }: ComponentProps<"blockquote">) {
  return (
    <blockquote className="md-blockquote" {...props}>
      {children}
    </blockquote>
  );
}

// ── Table Wrapper (horizontal scroll + fixed header) ─────────────────
function TableWrapper({ children, ...props }: ComponentProps<"table">) {
  return (
    <div className="md-table-wrapper">
      <table className="md-table" {...props}>
        {children}
      </table>
    </div>
  );
}

// ── Link (external link icon) ────────────────────────────────────────
function Anchor({ children, href, ...props }: ComponentProps<"a">) {
  const isExternal =
    href && (href.startsWith("http://") || href.startsWith("https://"));

  return (
    <a
      href={href}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
      className="md-link"
      {...props}
    >
      {children}
    </a>
  );
}

// ── Image ─────────────────────────────────────────────────────────────
function Image({ src, alt, ...props }: ComponentProps<"img">) {
  return (
    <span className="md-image-wrap">
      <img src={src} alt={alt} className="md-image" loading="lazy" {...props} />
      {alt && (
        <Text type="secondary" className="md-image-alt">
          {alt}
        </Text>
      )}
    </span>
  );
}

// ── Task List Item (read-only, no interactive checkbox) ───────────────
function TaskListItem({
  children,
  checked,
  ...props
}: ComponentProps<"li"> & { checked?: boolean }) {
  return (
    <li className={`md-task-item ${checked ? "md-task-checked" : ""}`} {...props}>
      <span className="md-task-checkbox">
        {checked ? (
          <CheckCircleFilled style={{ color: "#10b981" }} />
        ) : (
          <span className="md-task-empty" />
        )}
      </span>
      <span className="md-task-content">{children}</span>
    </li>
  );
}

// ── Read-only list item (for non-task lists, no checkbox) ────────────
function ListItem({ children, ...props }: ComponentProps<"li">) {
  return (
    <li className="md-list-item" {...props}>
      {children}
    </li>
  );
}

// ── Horizontal Rule ───────────────────────────────────────────────────
function HorizontalRule(props: ComponentProps<"hr">) {
  return <hr className="md-hr" {...props} />;
}

// ── Aggregated Components Map ─────────────────────────────────────────
const markdownComponents: Components = {
  code: InlineCode as any,
  pre: CodeBlock as any,
  blockquote: BlockQuote as any,
  table: TableWrapper as any,
  a: Anchor as any,
  img: Image as any,
  li: (({ checked, ...props }: ComponentProps<"li"> & { checked?: boolean }) => {
    // Only use TaskListItem for GFM task lists (where checked is defined)
    // This renders a read-only indicator, not an interactive checkbox
    if (checked !== undefined) {
      return <TaskListItem checked={checked} {...props} />;
    }
    return <ListItem {...props} />;
  }) as any,
  hr: HorizontalRule as any,
};

// ── Main MarkdownRenderer ────────────────────────────────────────────
export interface MarkdownRendererProps {
  /** Markdown string content to render */
  content: string;
  /** Whether the content is still being streamed */
  isStreaming?: boolean;
  /** Additional CSS class name */
  className?: string;
  /** Enable animation for new content during streaming */
  animated?: boolean;
}

/**
 * Core Markdown renderer for SunPilot chat responses.
 *
 * Wraps Streamdown (Vercel's streaming-aware react-markdown replacement)
 * with custom component overrides for code blocks, tables, links,
 * task lists, and more — all styled to match SunPilot's design language.
 *
 * When `isStreaming` is true:
 * - Uses `mode="streaming"` with `parseIncompleteMarkdown` for graceful
 *   handling of unterminated fences, bold, italic, etc.
 * - Animates new content with fade-in for a smooth reading experience.
 *
 * When `isStreaming` is false:
 * - Uses `mode="static"` for final render.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  isStreaming = false,
  className = "",
  animated = true,
}: MarkdownRendererProps) {
  if (!content || content.trim().length === 0) {
    return null;
  }

  return (
    <div className={`markdown-renderer ${className}`.trim()}>
      <Streamdown
        mode={isStreaming ? "streaming" : "static"}
        parseIncompleteMarkdown={isStreaming}
        components={markdownComponents}
        animated={animated && isStreaming}
        className="markdown-body"
      >
        {content}
      </Streamdown>
    </div>
  );
});
