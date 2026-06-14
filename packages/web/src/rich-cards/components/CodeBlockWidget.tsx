import { memo, useCallback, useState } from "react";
import { Card, Button, Typography, Flex, message } from "antd";
import {
  CopyOutlined,
  DownloadOutlined,
  UpOutlined,
  DownOutlined,
  FileOutlined,
} from "@ant-design/icons";

const { Text } = Typography;

// ── Types ─────────────────────────────────────────────────────────────

export interface CodeBlockWidgetProps {
  /** The code content */
  code: string;
  /** Programming language for syntax highlighting */
  language?: string;
  /** Optional file name to display in the header */
  fileName?: string;
  /** Whether to show the collapse button for long code blocks */
  collapsible?: boolean;
  /** Maximum visible lines before collapsing (default: 20) */
  collapseThreshold?: number;
  /** Card title */
  title?: string;
  /** Card subtitle */
  subtitle?: string;
  /** Show border/card wrapper */
  bordered?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────

export const CodeBlockWidget = memo(function CodeBlockWidget({
  code,
  language,
  fileName,
  collapsible = true,
  collapseThreshold = 20,
  title,
  subtitle,
  bordered = true,
}: CodeBlockWidgetProps) {
  const [collapsed, setCollapsed] = useState(false);

  const lineCount = code.split("\n").length;
  const isLong = lineCount > collapseThreshold;
  const showCollapse = collapsible && isLong;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      message.success("代码已复制");
    });
  }, [code]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || `snippet.${language || "txt"}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [code, fileName, language]);

  const headerContent = (
    <Flex
      justify="space-between"
      align="center"
      className="code-block-widget__header"
    >
      <Flex align="center" gap={8}>
        <FileOutlined />
        <Text className="code-block-widget__filename">
          {fileName || "snippet"}
        </Text>
        {language && (
          <Text type="secondary" className="code-block-widget__lang">
            {language}
          </Text>
        )}
      </Flex>
      <Flex gap={4}>
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          onClick={handleCopy}
        >
          复制
        </Button>
        <Button
          type="text"
          size="small"
          icon={<DownloadOutlined />}
          onClick={handleDownload}
        >
          下载
        </Button>
      </Flex>
    </Flex>
  );

  const codeContent = (
    <div className={`code-block-widget ${bordered ? "code-block-widget--bordered" : ""}`}>
      {headerContent}
      <pre
        className={`code-block-widget__pre ${collapsed ? "code-block-widget__pre--collapsed" : ""}`}
      >
        <code className={language ? `language-${language}` : undefined}>
          {code}
        </code>
      </pre>
      {showCollapse && (
        <Button
          type="text"
          size="small"
          icon={collapsed ? <DownOutlined /> : <UpOutlined />}
          onClick={() => setCollapsed(!collapsed)}
          className="code-block-widget__collapse-btn"
        >
          {collapsed ? `展开代码 (${lineCount} 行)` : "收起代码"}
        </Button>
      )}
    </div>
  );

  if (title) {
    return (
      <Card
        title={title}
        size="small"
        className="code-block-widget-card"
        styles={{
          body: { padding: 0 },
        }}
      >
        {subtitle && (
          <Text
            type="secondary"
            style={{ display: "block", margin: "0 0 12px 0", padding: "0 16px" }}
          >
            {subtitle}
          </Text>
        )}
        {codeContent}
      </Card>
    );
  }

  return codeContent;
});

export default CodeBlockWidget;
