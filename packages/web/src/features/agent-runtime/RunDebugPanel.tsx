/**
 * Run Debug Panel — Ant Design powered trace/plan/tool viewer (§P3-11).
 */

import { useState, useEffect, useCallback, type ReactNode } from "react";
import {
  Spin, Result, Empty, Card, Tag, Tabs, Timeline,
  Alert, Flex, Typography, Button, Space, List, Row, Col, Divider,
} from "antd";
import {
  ReloadOutlined, ArrowLeftOutlined,
  ClockCircleOutlined, ThunderboltOutlined, ToolOutlined,
  RobotOutlined, NodeIndexOutlined, ExclamationCircleOutlined,
  SafetyOutlined,
  FileSearchOutlined, ExperimentOutlined,
} from "@ant-design/icons";
import "./RunDebugPanel.css";

const { Title, Text, Paragraph } = Typography;

// ── Types ─────────────────────────────────────────────────────────────────

interface TraceResponse {
  runId: string;
  conversationId?: string;
  status: string;
  mode: string;
  activePlan: Record<string, unknown> | null;
  planRevisionCount: number;
  trace: {
    traceId: string;
    totalDurationMs: number;
    totalTokenInput: number;
    totalTokenOutput: number;
    totalToolCalls: number;
    totalToolFailures: number;
    totalModelCalls: number;
    totalErrors: number;
    spanCount: number;
  } | null;
  spans: SpanRecord[];
  planSnapshots: PlanSnapshot[];
  timeline: {
    statusHistory: StatusTransition[];
    events: TimelineEvent[];
  };
  modelCalls: ModelCallRecord[];
  toolCalls: ToolCallRecord[];
  approvals: ApprovalRecord[];
}

interface SpanRecord {
  id: string;
  kind: string;
  summary: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  tokenInput: number;
  tokenOutput: number;
  toolCallsCount: number;
  toolFailures: number;
  modelCallsCount: number;
  error?: string;
}

interface PlanSnapshot {
  id: string;
  version: number;
  eventType: string;
  diffSummary?: string;
  trigger?: string;
  addedSteps: number;
  removedSteps: number;
  modifiedSteps: number;
  createdAt: string;
}

interface StatusTransition {
  from: string;
  to: string;
  reason?: string;
  at: string;
}

interface TimelineEvent {
  type: string;
  sequence: number;
  at: string;
}

interface ModelCallRecord {
  id: string;
  provider: string;
  model: string;
  purpose: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: unknown;
}

interface ToolCallRecord {
  id: string;
  skillId: string;
  name: string;
  status: string;
  riskLevel: string;
  metadata?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
}

interface ApprovalRecord {
  id: string;
  title: string;
  status: string;
  risk: string;
}

interface RunSummary {
  id: string;
  status: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function statusTagColor(status: string): string {
  switch (status) {
    case "completed": return "success";
    case "running":   return "processing";
    case "failed":    return "error";
    case "cancelled": return "default";
    case "timeout":   return "warning";
    case "pending":   return "warning";
    default:          return "default";
  }
}

function riskTagColor(risk: string): string {
  switch (risk) {
    case "low":      return "success";
    case "medium":   return "warning";
    case "high":     return "error";
    case "critical": return "#9d174d";
    default:         return "default";
  }
}

function spanKindColor(kind: string): string {
  switch (kind) {
    case "llm":    return "blue";
    case "tool":   return "green";
    case "plan":   return "purple";
    case "safety": return "gold";
    default:       return "default";
  }
}

// ── Component ─────────────────────────────────────────────────────────────

interface RunDebugPanelProps {
  runId: string | null;
  conversationId?: string;
  baseUrl?: string;
}

export function RunDebugPanel({ runId, conversationId, baseUrl = "" }: RunDebugPanelProps) {
  const [data, setData] = useState<TraceResponse | null>(null);
  const [loading, setLoading] = useState(Boolean(runId));
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(runId);
  const [runList, setRunList] = useState<RunSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => { if (runId) setSelectedRunId(runId); }, [runId]);

  useEffect(() => {
    if (runId || !conversationId) return;
    setListLoading(true);
    fetch(`${baseUrl}/v1/runs?conversationId=${conversationId}&limit=10`)
      .then((res) => res.json())
      .then((json: { items?: RunSummary[] }) => {
        setRunList((json.items ?? []).filter((r) => r.status !== "running"));
      })
      .catch(() => setRunList([]))
      .finally(() => setListLoading(false));
  }, [runId, conversationId, baseUrl]);

  const fetchTrace = useCallback(async () => {
    if (!selectedRunId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${baseUrl}/v1/runs/${selectedRunId}/trace`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as TraceResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trace");
    } finally {
      setLoading(false);
    }
  }, [selectedRunId, baseUrl]);

  useEffect(() => { fetchTrace(); }, [fetchTrace]);

  // ── Loading ──
  if (loading) {
    return (
      <Flex align="center" justify="center" className="run-debug-panel">
        <Spin size="large" tip="Loading trace…">
          <div style={{ padding: 60 }} />
        </Spin>
      </Flex>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <Flex align="center" justify="center" className="run-debug-panel">
        <Result
          status="error"
          title="Failed to load trace"
          subTitle={error}
          extra={<Button type="primary" onClick={fetchTrace}>Retry</Button>}
        />
      </Flex>
    );
  }

  // ── Empty / picker ──
  if (!data) {
    if (listLoading) {
      return (
        <Flex align="center" justify="center" className="run-debug-panel">
          <Spin size="large" tip="Loading runs…">
            <div style={{ padding: 60 }} />
          </Spin>
        </Flex>
      );
    }
    return (
      <Flex vertical align="center" justify="center" className="run-debug-panel">
        <Empty
          image={<ExperimentOutlined style={{ fontSize: 48, color: "var(--sp-subtle)" }} />}
          description={
            <Flex vertical gap={4}>
              <Title level={5} style={{ margin: 0 }}>
                {runId ? "Loading trace…" : "No active run"}
              </Title>
              <Text type="secondary">
                {runList.length > 0
                  ? "Select a past run below to inspect its trace, spans, tools, and plan."
                  : "No past runs found for this conversation. Start a chat to generate one."}
              </Text>
            </Flex>
          }
        >
          {runList.length > 0 && (
            <List
              dataSource={runList}
              style={{ maxWidth: 520, width: "100%" }}
              renderItem={(r) => (
                <List.Item
                  extra={
                    <Button type="primary" size="small" onClick={() => setSelectedRunId(r.id)}>
                      View
                    </Button>
                  }
                >
                  <List.Item.Meta
                    avatar={<Tag color={statusTagColor(r.status)}>{r.status}</Tag>}
                    title={<Text code>{r.id.slice(0, 14)}…</Text>}
                    description={fmtDate(r.createdAt)}
                  />
                </List.Item>
              )}
            />
          )}
        </Empty>
      </Flex>
    );
  }

  const safetyEvents = data.timeline.events.filter((e) =>
    e.type.startsWith("agent.safety."),
  );

  // ── Tab items ──
  const tabItems = [
    {
      key: "overview",
      label: "Overview",
      icon: <FileSearchOutlined />,
      children: <OverviewTab data={data} />,
    },
    {
      key: "spans",
      label: `Spans (${data.spans.length})`,
      icon: <NodeIndexOutlined />,
      children: <SpansTab spans={data.spans} />,
    },
    {
      key: "tools",
      label: `Tools (${data.toolCalls.length})`,
      icon: <ToolOutlined />,
      children: <ToolsTab toolCalls={data.toolCalls} />,
    },
    {
      key: "models",
      label: `Models (${data.modelCalls.length})`,
      icon: <RobotOutlined />,
      children: <ModelsTab modelCalls={data.modelCalls} />,
    },
    {
      key: "plan",
      label: `Plan (${data.planRevisionCount})`,
      icon: <ThunderboltOutlined />,
      children: <PlanTab data={data} />,
    },
  ];

  return (
    <Flex vertical className="run-debug-panel">
      <div className="run-debug-panel__scroll">
        {/* ── Header ── */}
        <Flex align="center" gap={12} className="run-debug-header">
          <Title level={4} style={{ margin: 0 }}>
            <FileSearchOutlined style={{ marginRight: 8 }} />
            Run Debug
          </Title>
          <Tag color={statusTagColor(data.status)}>{data.status}</Tag>
          {!runId && runList.length > 0 && (
            <Button
              size="small"
              icon={<ArrowLeftOutlined />}
              style={{ marginLeft: "auto" }}
              onClick={() => { setSelectedRunId(null); setData(null); }}
            >
              Back to list
            </Button>
          )}
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            onClick={fetchTrace}
          />
        </Flex>

        {/* ── Stats ── */}
        {data.trace && (
          <Row gutter={[10, 10]} style={{ marginBottom: 20 }}>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small">
                <StatCell icon={<ClockCircleOutlined />} label="Duration" value={fmtMs(data.trace.totalDurationMs)} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small">
                <StatCell icon="📥" label="Input Tokens" value={fmtTokens(data.trace.totalTokenInput)} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small">
                <StatCell icon="📤" label="Output Tokens" value={fmtTokens(data.trace.totalTokenOutput)} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small">
                <StatCell
                  icon={<ToolOutlined />}
                  label="Tool Calls"
                  value={`${data.trace.totalToolCalls}`}
                  sub={data.trace.totalToolFailures > 0 ? `${data.trace.totalToolFailures} failed` : undefined}
                  tone={data.trace.totalToolFailures > 0 ? "warning" : undefined}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small">
                <StatCell icon={<RobotOutlined />} label="Model Calls" value={`${data.trace.totalModelCalls}`} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small">
                <StatCell
                  icon={<ExclamationCircleOutlined />}
                  label="Errors"
                  value={`${data.trace.totalErrors}`}
                  tone={data.trace.totalErrors > 0 ? "danger" : undefined}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small">
                <StatCell icon={<NodeIndexOutlined />} label="Spans" value={`${data.trace.spanCount}`} />
              </Card>
            </Col>
          </Row>
        )}

        {/* ── Safety alerts ── */}
        {safetyEvents.length > 0 && (
          <Alert
            type="warning"
            showIcon
            icon={<SafetyOutlined />}
            message={`Safety Events (${safetyEvents.length})`}
            description={
              <List
                size="small"
                dataSource={safetyEvents}
                renderItem={(e) => (
                  <List.Item style={{ padding: "2px 0", border: "none" }}>
                    <Tag style={{ fontSize: 10 }}>#{e.sequence}</Tag>
                    <Text style={{ fontSize: 12 }}>{e.type}</Text>
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: "auto" }}>
                      {fmtTime(e.at)}
                    </Text>
                  </List.Item>
                )}
              />
            }
            style={{ marginBottom: 20 }}
          />
        )}

        {/* ── Tabs ── */}
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={tabItems}
          size="small"
        />
      </div>
    </Flex>
  );
}

// ── Stat cell (replaces custom Stat component) ────────────────────────────

function StatCell({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: "warning" | "danger";
}) {
  return (
    <Flex vertical gap={2}>
      <Text type="secondary" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>
        {icon} {label}
      </Text>
      <Text strong style={{
        fontSize: 16,
        color: tone === "warning" ? "var(--sp-orange)" : tone === "danger" ? "var(--sp-red)" : "var(--sp-ink)",
      }}>
        {value}
      </Text>
      {sub && <Text type="secondary" style={{ fontSize: 10 }}>{sub}</Text>}
    </Flex>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────

function OverviewTab({ data }: { data: TraceResponse }) {
  return (
    <Flex vertical gap={20}>
      <div>
        <Text strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--sp-subtle)" }}>
          Status Timeline
        </Text>
        {data.timeline.statusHistory.length === 0 ? (
          <Empty description="No status transitions" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Timeline
            style={{ marginTop: 12 }}
            items={data.timeline.statusHistory.map((h, i) => ({
              key: i,
              color: "blue",
              children: (
                <Flex gap={8} align="center" wrap="wrap">
                  <Tag>{h.from}</Tag>
                  <Text>→</Text>
                  <Tag color="success">{h.to}</Tag>
                  {h.reason && <Text type="secondary">{h.reason}</Text>}
                  <Text type="secondary" style={{ fontSize: 11, marginLeft: "auto" }}>
                    {fmtTime(h.at)}
                  </Text>
                </Flex>
              ),
            }))}
          />
        )}
      </div>

      <div>
        <Text strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--sp-subtle)" }}>
          Approvals
        </Text>
        {data.approvals.length === 0 ? (
          <Empty description="No approvals" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <List
            style={{ marginTop: 8 }}
            dataSource={data.approvals}
            renderItem={(a) => (
              <List.Item>
                <List.Item.Meta
                  title={a.title}
                  description={
                    <Space size={6}>
                      <Tag color={statusTagColor(a.status)}>{a.status}</Tag>
                      <Tag color={riskTagColor(a.risk)}>{a.risk}</Tag>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </div>
    </Flex>
  );
}

// ── Spans tab ─────────────────────────────────────────────────────────────

function SpansTab({ spans }: { spans: SpanRecord[] }) {
  if (spans.length === 0) {
    return <Empty description="No spans recorded" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <Flex vertical gap={10}>
      {spans.map((s) => (
        <Card
          key={s.id}
          size="small"
          title={
            <Flex align="center" gap={8}>
              <Tag color={spanKindColor(s.kind)}>{s.kind}</Tag>
            </Flex>
          }
          extra={<Text type="secondary" code>{fmtMs(s.durationMs)}</Text>}
          style={s.error ? { borderLeft: "3px solid var(--sp-red)" } : undefined}
        >
          <Paragraph style={{ marginBottom: 8 }}>{s.summary}</Paragraph>
          <Flex gap={16} wrap="wrap">
            <Text type="secondary" style={{ fontSize: 12 }}>
              📥 {fmtTokens(s.tokenInput)} → 📤 {fmtTokens(s.tokenOutput)}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              🔧 {s.toolCallsCount} calls{s.toolFailures > 0 && ` (${s.toolFailures} failed)`}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              🧠 {s.modelCallsCount} models
            </Text>
          </Flex>
          {s.error && (
            <Alert type="error" message={s.error} style={{ marginTop: 8 }} />
          )}
        </Card>
      ))}
    </Flex>
  );
}

// ── Tools tab ─────────────────────────────────────────────────────────────

function ToolsTab({ toolCalls }: { toolCalls: ToolCallRecord[] }) {
  if (toolCalls.length === 0) {
    return <Empty description="No tool calls recorded" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <Flex vertical gap={10}>
      {toolCalls.map((tc) => {
        const meta = tc.metadata as Record<string, unknown> | undefined;
        const decisionPath = typeof meta?.decisionPath === "string" ? meta.decisionPath : undefined;
        const planStepId = typeof meta?.planStepId === "string" ? meta.planStepId : undefined;
        const safety = meta?.safety != null ? meta.safety : undefined;

        return (
          <Card
            key={tc.id}
            size="small"
            title={<Text code>{tc.name}</Text>}
            extra={
              <Space size={6}>
                <Tag color={statusTagColor(tc.status)}>{tc.status}</Tag>
                <Tag color={riskTagColor(tc.riskLevel)}>{tc.riskLevel}</Tag>
              </Space>
            }
          >
            <Text type="secondary" style={{ fontSize: 11 }} code>
              {tc.skillId}
            </Text>

            {(decisionPath || planStepId || safety) && (
              <Flex gap={8} wrap="wrap" style={{ marginTop: 6 }}>
                {decisionPath && <Tag>🧭 {decisionPath}</Tag>}
                {planStepId && <Tag>📐 {planStepId.slice(0, 14)}…</Tag>}
                {safety && <Tag color="warning">⚠️ {JSON.stringify(safety)}</Tag>}
              </Flex>
            )}

            {(tc.startedAt || tc.completedAt) && (
              <Flex gap={16} style={{ marginTop: 8 }}>
                {tc.startedAt && <Text type="secondary" style={{ fontSize: 11 }} code>▶ {fmtTime(tc.startedAt)}</Text>}
                {tc.completedAt && <Text type="secondary" style={{ fontSize: 11 }} code>✓ {fmtTime(tc.completedAt)}</Text>}
              </Flex>
            )}
          </Card>
        );
      })}
    </Flex>
  );
}

// ── Models tab ────────────────────────────────────────────────────────────

function ModelsTab({ modelCalls }: { modelCalls: ModelCallRecord[] }) {
  if (modelCalls.length === 0) {
    return <Empty description="No model calls recorded" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <Flex vertical gap={10}>
      {modelCalls.map((mc) => (
        <Card
          key={mc.id}
          size="small"
          title={<Text code>{mc.provider}/{mc.model}</Text>}
          extra={
            <Space size={6}>
              <Tag>{mc.purpose}</Tag>
              <Tag color={statusTagColor(mc.status)}>{mc.status}</Tag>
            </Space>
          }
        >
          <Flex gap={20} wrap="wrap">
            <Text style={{ fontSize: 13 }}>
              📥 <Text strong>{fmtTokens(mc.inputTokens)}</Text> in
            </Text>
            <Text style={{ fontSize: 13 }}>
              📤 <Text strong>{fmtTokens(mc.outputTokens)}</Text> out
            </Text>
            <Text style={{ fontSize: 13 }}>
              ⏱ <Text strong>{fmtMs(mc.latencyMs)}</Text>
            </Text>
          </Flex>
          {mc.error != null && (
            <Alert type="error" message={String(mc.error)} style={{ marginTop: 8 }} />
          )}
        </Card>
      ))}
    </Flex>
  );
}

// ── Plan tab ──────────────────────────────────────────────────────────────

function PlanTab({ data }: { data: TraceResponse }) {
  return (
    <Flex vertical gap={4}>
      <Flex align="center" gap={8} style={{ marginBottom: 16 }}>
        <Text strong>Plan Revisions</Text>
        <Tag color="purple">{data.planRevisionCount}</Tag>
      </Flex>

      {data.planSnapshots.length === 0 ? (
        <Empty description="No plan snapshots recorded" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        data.planSnapshots.map((ps) => (
          <Card
            key={ps.id}
            size="small"
            style={{ marginBottom: 10, borderLeft: "3px solid var(--sp-purple)" }}
            title={
              <Space size={6}>
                <Tag color="purple">v{ps.version}</Tag>
                <Text>{ps.eventType}</Text>
                {ps.trigger && <Text type="secondary">— {ps.trigger}</Text>}
              </Space>
            }
          >
            {ps.diffSummary && (
              <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8, padding: 8, background: "var(--sp-surface-soft)", borderRadius: 8 }}>
                {ps.diffSummary}
              </Paragraph>
            )}
            <Space size={8}>
              <Tag color="success">+{ps.addedSteps} added</Tag>
              <Tag color="error">-{ps.removedSteps} removed</Tag>
              <Tag color="warning">~{ps.modifiedSteps} modified</Tag>
            </Space>
            <br />
            <Text type="secondary" style={{ fontSize: 11 }} code>
              {fmtDate(ps.createdAt)}
            </Text>
          </Card>
        ))
      )}
    </Flex>
  );
}
