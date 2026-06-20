import { useState } from "react";
import {
  CheckCircleFilled,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, Radio, Typography, Tag, Rate } from "antd";
import type {
  ChoiceGroupCardData,
  ApprovalSummaryCardData,
  ActionListCardData,
  RatingCardData,
  KanbanCardData,
  FormCardData,
  DatePickerCardData,
} from "../types";
import type { RichTextValue } from "../types";
import { RichCardShell } from "./RichCardShell";

const { Text } = Typography;

// ── ChoiceGroupCard ──────────────────────────────────────────────────

export function ChoiceGroupCard({
  title,
  subtitle,
  data,
  cardState,
  onAction,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: ChoiceGroupCardData;
  cardState?: { selectedIds?: string[] };
  onAction?: (action: { type: string; payload?: Record<string, unknown> }) => void;
}) {
  const [localSelected, setLocalSelected] = useState<string[]>(
    data.selectedIds ?? [],
  );

  const selectedIds = cardState?.selectedIds ?? localSelected;

  const handleSelect = (id: string) => {
    let next: string[];
    if (data.mode === "single") {
      next = [id];
    } else {
      next = selectedIds.includes(id)
        ? selectedIds.filter((s) => s !== id)
        : [...selectedIds, id];
    }
    setLocalSelected(next);
    onAction?.({ type: "submit", payload: { selectedIds: next } });
  };

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-choice-group">
        {data.options.map((option) => (
          <div
            key={option.id}
            className={`rich-choice-group__option ${selectedIds.includes(option.id) ? "rich-choice-group__option--selected" : ""}`}
            onClick={() => handleSelect(option.id)}
          >
            {data.mode === "single" ? (
              <Radio checked={selectedIds.includes(option.id)} />
            ) : (
              <Checkbox checked={selectedIds.includes(option.id)} />
            )}
            <div>
              <Text>{option.label}</Text>
              {option.description && (
                <Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                  {option.description}
                </Text>
              )}
            </div>
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

// ── ApprovalSummaryCard ──────────────────────────────────────────────

export function ApprovalSummaryCard({
  title,
  subtitle,
  data,
  onAction,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: ApprovalSummaryCardData;
  onAction?: (action: { type: string; itemId?: string; payload?: Record<string, unknown> }) => void;
}) {
  const riskColor = (level?: string) => {
    switch (level) {
      case "high": return "red";
      case "medium": return "orange";
      case "low": return "green";
      default: return "default";
    }
  };

  const statusIcon = (status?: string) => {
    switch (status) {
      case "approved": return <CheckCircleFilled style={{ color: "#10b981" }} />;
      case "rejected": return <CloseCircleOutlined style={{ color: "#ef4444" }} />;
      default: return <ThunderboltOutlined style={{ color: "#f59e0b" }} />;
    }
  };

  return (
    <RichCardShell title={title ?? "审批摘要"} subtitle={subtitle}>
      <div className="rich-approval">
        {data.riskLevel && (
          <div className="rich-approval__risk">
            <Text>风险等级: </Text>
            <Tag color={riskColor(data.riskLevel)}>{data.riskLevel}</Tag>
          </div>
        )}
        {data.items.map((item) => (
          <div key={item.id} className="rich-approval__item">
            <div className="rich-approval__header">
              {statusIcon(item.status)}
              <Text strong>{item.title}</Text>
              {item.riskLevel && <Tag color={riskColor(item.riskLevel)}>{item.riskLevel}</Tag>}
            </div>
            {item.description && <Text type="secondary">{item.description}</Text>}
            {item.status === "pending" && (
              <div className="rich-approval__actions">
                <Button
                  size="small"
                  type="primary"
                  onClick={() => onAction?.({ type: "submit", itemId: item.id, payload: { decision: "approved" } })}
                >
                  同意
                </Button>
                <Button
                  size="small"
                  danger
                  onClick={() => onAction?.({ type: "submit", itemId: item.id, payload: { decision: "rejected" } })}
                >
                  拒绝
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

// ── ActionListCard ───────────────────────────────────────────────────

export function ActionListCard({
  title,
  subtitle,
  data,
  onAction,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: ActionListCardData;
  onAction?: (action: { type: string; itemId?: string; payload?: Record<string, unknown> }) => void;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-action-list">
        {data.items.map((item) => (
          <div key={item.id} className={`rich-action-list__item ${item.completed ? "rich-action-list__item--completed" : ""}`}>
            <div className="rich-action-list__content">
              {item.completed ? (
                <CheckCircleFilled style={{ color: "#10b981" }} />
              ) : (
                <CheckCircleOutlined style={{ color: "#94a3b8" }} />
              )}
              <div>
                <Text delete={item.completed}>{item.title}</Text>
                {item.description && (
                  <Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                    {item.description}
                  </Text>
                )}
              </div>
            </div>
            {item.action && !item.completed && (
              <Button
                size="small"
                type="primary"
                ghost
                onClick={() => onAction?.({ type: item.action!.type, itemId: item.id, payload: item.action!.payload })}
              >
                {item.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

// ── RatingCard ───────────────────────────────────────────────────────

export function RatingCard({
  title,
  subtitle,
  data,
  onAction,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: RatingCardData;
  onAction?: (action: { type: string; payload?: Record<string, unknown> }) => void;
}) {
  const [value, setValue] = useState(data.value ?? 0);

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-rating">
        <Rate count={data.scale} value={value} onChange={(v) => { setValue(v); onAction?.({ type: "submit", payload: { value: v } }); }} />
        {data.labels && (
          <div className="rich-rating__labels">
            {data.labels.map((label, i) => (
              <Text key={i} type="secondary" style={{ fontSize: 11 }}>{label}</Text>
            ))}
          </div>
        )}
      </div>
    </RichCardShell>
  );
}

// ── KanbanCard ───────────────────────────────────────────────────────

export function KanbanCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: KanbanCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-kanban">
        {data.columns.map((col) => (
          <div key={col.id} className="rich-kanban__column">
            <Text strong className="rich-kanban__column-title">{col.label}</Text>
            <div className="rich-kanban__cards">
              {data.cards
                .filter((card) => card.columnId === col.id)
                .map((card) => (
                  <div key={card.id} className="rich-kanban__card">
                    <Text>{card.title}</Text>
                    {card.description && (
                      <Text type="secondary" style={{ fontSize: 12 }}>{card.description}</Text>
                    )}
                    {card.badge && <Tag>{card.badge}</Tag>}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

// ── FormCard ─────────────────────────────────────────────────────────

export function FormCard({
  title,
  subtitle,
  data,
  onAction,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: FormCardData;
  onAction?: (action: { type: string; payload?: Record<string, unknown> }) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  const handleChange = (fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  };

  const handleSubmit = () => {
    onAction?.({ type: "submit", payload: values });
  };

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-form">
        {data.fields.map((field) => (
          <div key={field.id} className="rich-form__field">
            <Text className="rich-form__label">
              {field.label}
              {field.required && <Text type="danger"> *</Text>}
            </Text>
            {field.type === "textarea" ? (
              <textarea
                className="rich-form__textarea"
                placeholder={field.placeholder}
                value={values[field.id] ?? ""}
                onChange={(e) => handleChange(field.id, e.target.value)}
              />
            ) : field.type === "select" ? (
              <select
                className="rich-form__select"
                value={values[field.id] ?? ""}
                onChange={(e) => handleChange(field.id, e.target.value)}
              >
                <option value="">{field.placeholder ?? "请选择"}</option>
                {field.options?.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            ) : (
              <input
                className="rich-form__input"
                type={field.type === "number" ? "number" : field.type === "email" ? "email" : "text"}
                placeholder={field.placeholder}
                value={values[field.id] ?? ""}
                onChange={(e) => handleChange(field.id, e.target.value)}
              />
            )}
          </div>
        ))}
        <Button type="primary" onClick={handleSubmit}>
          {data.submitLabel ?? "提交"}
        </Button>
      </div>
    </RichCardShell>
  );
}

// ── DatePickerCard ───────────────────────────────────────────────────

export function DatePickerCard({
  title,
  subtitle,
  data,
  onAction,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: DatePickerCardData;
  onAction?: (action: { type: string; payload?: Record<string, unknown> }) => void;
}) {
  const [value, setValue] = useState(data.value ?? "");

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-date-picker">
        <input
          className="rich-form__input"
          type={data.mode === "time" ? "time" : data.mode === "datetime" ? "datetime-local" : "date"}
          value={value}
          min={data.min}
          max={data.max}
          onChange={(e) => {
            setValue(e.target.value);
            onAction?.({ type: "submit", payload: { value: e.target.value } });
          }}
        />
      </div>
    </RichCardShell>
  );
}
