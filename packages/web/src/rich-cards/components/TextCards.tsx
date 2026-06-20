import { useState } from "react";
import {
  CopyOutlined,
  DownOutlined,
  RightOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { Button, Typography, Flex, Tag, message } from "antd";
import type {
  RichTextCardData,
  DefinitionListCardData,
  QuoteCardData,
  CitationListCardData,
  CodeDiffCardData,
  JsonViewerCardData,
  ComparisonTableCardData,
  RankedListCardData,
} from "../types";
import type { RichTextValue } from "../types";
import { RichCardShell } from "./RichCardShell";
import { RichTextRenderer } from "../richText";

const { Text, Paragraph } = Typography;

// ── RichTextCard ─────────────────────────────────────────────────────

export function RichTextCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: RichTextCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <RichTextRenderer value={data.content} inline={false} />
    </RichCardShell>
  );
}

// ── DefinitionListCard ───────────────────────────────────────────────

export function DefinitionListCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: DefinitionListCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-definition-list">
        {data.items.map((item, idx) => (
          <div key={`${item.term}-${idx}`} className="rich-definition-list__item">
            <Text strong className="rich-definition-list__term">{item.term}</Text>
            <Text type="secondary">{item.description}</Text>
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

// ── QuoteCard ────────────────────────────────────────────────────────

export function QuoteCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: QuoteCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <blockquote className="rich-quote">
        <Paragraph italic>{data.quote}</Paragraph>
        {data.source && (
          <Text type="secondary" className="rich-quote__source">
            — {data.source}
            {data.url && (
              <a href={data.url} target="_blank" rel="noopener noreferrer" className="rich-text-link" style={{ marginLeft: 8 }}>
                <LinkOutlined /> 来源
              </a>
            )}
          </Text>
        )}
      </blockquote>
    </RichCardShell>
  );
}

// ── CitationListCard ─────────────────────────────────────────────────

export function CitationListCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: CitationListCardData;
}) {
  return (
    <RichCardShell title={title ?? "引用来源"} subtitle={subtitle}>
      <div className="rich-citation-list">
        {data.items.map((item, idx) => (
          <div key={`${item.title}-${idx}`} className="rich-citation-list__item">
            <Text strong>{idx + 1}. {item.title}</Text>
            {item.snippet && <Text type="secondary" style={{ fontSize: 12 }}>{item.snippet}</Text>}
            {item.url && (
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="rich-text-link" style={{ fontSize: 12 }}>
                <LinkOutlined /> {item.url}
              </a>
            )}
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

// ── CodeDiffCard ─────────────────────────────────────────────────────

export function CodeDiffCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: CodeDiffCardData;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const lines = data.diff.split("\n");

  const handleCopy = () => {
    navigator.clipboard.writeText(data.diff).then(() => message.success("已复制"));
  };

  return (
    <RichCardShell title={title} subtitle={subtitle} className="rich-card--code">
      <div className="rich-code__bar">
        <Text>{data.fileName ?? "diff"}</Text>
        {data.language && <Text strong> {data.language}</Text>}
        <Button type="text" size="small" icon={<CopyOutlined />} onClick={handleCopy} className="md-code-copy-btn">
          复制
        </Button>
      </div>
      <pre className={`rich-diff ${collapsed ? "rich-diff--collapsed" : ""}`}>
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={`rich-diff__line ${
              line.startsWith("+") ? "rich-diff__line--add" :
              line.startsWith("-") ? "rich-diff__line--remove" :
              ""
            }`}
          >
            {line}
          </div>
        ))}
      </pre>
      {lines.length > 20 && (
        <Button type="text" size="small" onClick={() => setCollapsed(!collapsed)} className="md-code-collapse-btn">
          {collapsed ? "展开" : "收起"}
        </Button>
      )}
    </RichCardShell>
  );
}

// ── JsonViewerCard ───────────────────────────────────────────────────

export function JsonViewerCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: JsonViewerCardData;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const depth = data.collapsedDepth ?? 2;

  const jsonStr = typeof data.value === "string" ? data.value : JSON.stringify(data.value, null, 2);

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonStr).then(() => message.success("已复制"));
  };

  return (
    <RichCardShell title={title} subtitle={subtitle} className="rich-card--code">
      <div className="rich-code__bar">
        <Text>{data.rootName ?? "JSON"}</Text>
        <Button type="text" size="small" icon={<CopyOutlined />} onClick={handleCopy} className="md-code-copy-btn">
          复制
        </Button>
      </div>
      <pre className={`rich-code ${collapsed ? "md-code-collapsed" : ""}`}>
        <code>{jsonStr}</code>
      </pre>
      {jsonStr.split("\n").length > 20 && (
        <Button type="text" size="small" onClick={() => setCollapsed(!collapsed)} className="md-code-collapse-btn">
          {collapsed ? "展开" : "收起"}
        </Button>
      )}
    </RichCardShell>
  );
}

// ── ComparisonTableCard ──────────────────────────────────────────────

export function ComparisonTableCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: ComparisonTableCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-comparison-table">
        <table className="md-table">
          <thead>
            <tr>
              <th></th>
              {data.subjects.map((s) => (
                <th key={s.name}>{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.criteria.map((criterion, ri) => (
              <tr key={criterion.key}>
                <td><Text strong>{criterion.label}</Text></td>
                {data.values[ri]?.map((val, ci) => (
                  <td key={ci}>
                    {typeof val === "boolean" ? (
                      val ? <Tag color="green">✓</Tag> : <Tag color="red">✗</Tag>
                    ) : val === null ? (
                      <Text type="secondary">-</Text>
                    ) : (
                      <Text>{String(val)}</Text>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </RichCardShell>
  );
}

// ── RankedListCard ───────────────────────────────────────────────────

export function RankedListCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: RankedListCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-ranked-list">
        {data.items.map((item, idx) => (
          <div key={`${item.title}-${idx}`} className="rich-ranked-list__item">
            <Text strong className="rich-ranked-list__rank">#{idx + 1}</Text>
            <div className="rich-ranked-list__content">
              <Text strong>{item.title}</Text>
              {item.score != null && <Tag color="blue">{item.score}</Tag>}
              {item.badge && <Tag>{item.badge}</Tag>}
              {item.description && <Text type="secondary" style={{ fontSize: 12 }}>{item.description}</Text>}
            </div>
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}
