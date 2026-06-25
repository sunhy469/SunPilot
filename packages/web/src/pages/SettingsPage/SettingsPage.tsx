import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Typography,
  Select,
  Button,
  Spin,
  Alert,
  Empty,
  Tag,
  Card,
  Space,
  Flex,
  message,
  Popconfirm,
  Modal,
  Input,
} from "antd";
import { ReloadOutlined, DeleteOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { createRequest } from "../../shared/api/client";
import "./SettingsPage.scss";

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

/**
 * W5: replace window.prompt with an antd Modal.confirm + TextArea dialog.
 * Resolves to the entered text, or null if cancelled.
 */
function promptText(title: string, placeholder?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let value = "";
    Modal.confirm({
      title,
      content: (
        <TextArea
          placeholder={placeholder}
          autoFocus
          onChange={(e) => {
            value = e.target.value;
          }}
        />
      ),
      onOk: () => resolve(value),
      onCancel: () => resolve(null),
    });
  });
}

interface MemoryItem {
  id: string;
  key: string;
  title?: string;
  content?: string;
  summary?: string;
  scope?: string;
  type?: string;
  confidence?: number;
  importance?: number;
  source?: string;
  createdAt: string;
  updatedAt?: string;
  supersededBy?: string;
  staleReason?: string;
  staleSince?: string;
  deletedAt?: string;
}

const SCOPE_COLORS: Record<string, string> = {
  global: "blue",
  user: "purple",
  project: "cyan",
  conversation: "green",
  run: "orange",
};

const TYPE_COLORS: Record<string, string> = {
  user_preference: "magenta",
  project_profile: "blue",
  workflow_pattern: "geekblue",
  error_solution: "red",
  conversation_summary: "green",
  tool_observation: "orange",
  manual_note: "default",
};

export function SettingsPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  // W5: use the shared API client instead of a bare fetch wrapper.
  const request = useMemo(() => createRequest(), []);

  const fetchMemories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request<{ items: MemoryItem[] }>("/v1/memory?limit=200");
      setMemories(res.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memories");
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  const markStale = async (id: string) => {
    // W5: use Modal.confirm + TextArea instead of window.prompt
    const reason = await promptText("Reason for marking stale:", "输入标记原因...");
    if (!reason) return;
    try {
      await request(`/v1/memory/${id}/mark-stale`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      message.success(`Memory marked as stale.`);
      fetchMemories();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to mark stale");
    }
  };

  const markSuperseded = async (id: string) => {
    // W5: use Modal.confirm + TextArea instead of window.prompt
    const supersededBy = await promptText("Superseded by (memory ID):", "输入替代 memory ID");
    if (!supersededBy) return;
    try {
      await request(`/v1/memory/${id}/supersede`, {
        method: "POST",
        body: JSON.stringify({ supersededBy }),
      });
      message.success(`Memory superseded.`);
      fetchMemories();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to supersede");
    }
  };

  const deleteMemory = async (id: string) => {
    try {
      await request(`/v1/memory/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: "deleted by user" }),
      });
      message.success(`Memory deleted.`);
      fetchMemories();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const filtered = memories.filter((m) => {
    if (m.deletedAt) return false;
    if (filter === "active") return !m.supersededBy && !m.staleReason;
    if (filter === "stale") return m.staleReason && !m.supersededBy;
    if (filter === "superseded") return m.supersededBy;
    return true;
  });

  return (
    <div className="settings-page">
      <Title level={2}>Settings</Title>

      <section className="settings-section">
        <Flex justify="space-between" align="center" className="section-header">
          <Title level={3} style={{ margin: 0 }}>Memory Management</Title>
          <Space>
            <Select
              value={filter}
              onChange={setFilter}
              style={{ width: 150 }}
              options={[
                { value: "all", label: "All Memories" },
                { value: "active", label: "Active Only" },
                { value: "stale", label: "Stale" },
                { value: "superseded", label: "Superseded" },
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={fetchMemories}>
              Refresh
            </Button>
          </Space>
        </Flex>

        {error && (
          <Alert
            type="error"
            message={error}
            closable
            onClose={() => setError(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        {loading ? (
          <Flex justify="center" style={{ padding: 48 }}>
            <Spin size="large" />
          </Flex>
        ) : filtered.length === 0 ? (
          <Empty description="No memories found." />
        ) : (
          <Flex vertical gap={12}>
            {filtered.map((m) => (
              <Card
                key={m.id}
                size="small"
                className={`memory-item ${m.staleReason ? "stale" : ""} ${m.supersededBy ? "superseded" : ""}`}
              >
                <Flex gap={8} align="center" wrap className="memory-header">
                  <Text code strong>{m.key}</Text>
                  <Tag color={SCOPE_COLORS[m.scope ?? ""] ?? "default"}>
                    {m.scope ?? "global"}
                  </Tag>
                  <Tag color={TYPE_COLORS[m.type ?? ""] ?? "default"}>
                    {m.type ?? "unknown"}
                  </Tag>
                  {m.confidence != null && (
                    <Text type="secondary" style={{ fontSize: 12, marginLeft: "auto" }}>
                      conf: {(m.confidence * 100).toFixed(0)}%
                    </Text>
                  )}
                </Flex>

                {m.title && <Text strong>{m.title}</Text>}
                {m.summary && <Paragraph ellipsis={{ rows: 2 }} type="secondary">{m.summary}</Paragraph>}
                {m.content && m.content !== m.summary && (
                  <Paragraph ellipsis={{ rows: 1 }} type="secondary" style={{ fontSize: 12 }}>
                    {m.content.slice(0, 300)}
                  </Paragraph>
                )}

                <Flex gap={12} className="memory-meta">
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    source: {m.source ?? "unknown"}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    created: {new Date(m.createdAt).toLocaleDateString()}
                  </Text>
                  {m.staleReason && (
                    <Tag color="warning" icon={<ExclamationCircleOutlined />}>
                      Stale: {m.staleReason}
                    </Tag>
                  )}
                  {m.supersededBy && (
                    <Tag>↪ Superseded by {m.supersededBy.slice(0, 12)}…</Tag>
                  )}
                </Flex>

                <Space style={{ marginTop: 8 }}>
                  {!m.staleReason && !m.supersededBy && (
                    <Button size="small" onClick={() => markStale(m.id)}>
                      Mark Stale
                    </Button>
                  )}
                  {!m.supersededBy && (
                    <Button size="small" onClick={() => markSuperseded(m.id)}>
                      Supersede
                    </Button>
                  )}
                  <Popconfirm
                    title="Delete this memory?"
                    onConfirm={() => deleteMemory(m.id)}
                    okText="Delete"
                    okType="danger"
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      Delete
                    </Button>
                  </Popconfirm>
                </Space>
              </Card>
            ))}
          </Flex>
        )}
      </section>
    </div>
  );
}
