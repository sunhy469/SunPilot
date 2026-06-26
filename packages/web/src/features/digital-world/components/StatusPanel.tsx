import { Drawer, Card, Avatar, Tag, Progress, Timeline, Statistic, Empty } from "antd";
import { DashboardOutlined, ClockCircleOutlined } from "@ant-design/icons";
import { useState, useEffect, useMemo } from "react";
import { createRequest } from "../../../shared/api/client";
import {
  getDigitalBeing,
  listActions,
  listActionLogs,
  listArtifacts,
  type BeingInfo,
} from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import "./StatusPanel.scss";

interface ActionRecord {
  id: string;
  status: string;
  type?: string;
  statusText?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface ActionLogRecord {
  id: string;
  eventType: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

interface ArtifactRecord {
  id: string;
  type: string;
  title: string;
  status: string;
  uri?: string;
  createdAt: string;
}

interface StatusPanelProps {
  open: boolean;
  beingId?: string;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  idle: "green",
  moving: "blue",
  working: "processing",
  waiting: "orange",
  sleeping: "default",
  error: "red",
  publishing: "geekblue",
};

const STATUS_LABELS: Record<string, string> = {
  idle: "空闲",
  moving: "移动中",
  working: "工作中",
  waiting: "等待中",
  sleeping: "休眠",
  error: "异常",
  publishing: "发布中",
};

const NODE_NAMES: Record<string, string> = {
  home: "家",
  video_workstation: "视频工作台",
  artifact_box: "产物箱",
  tiktok_station: "TikTok 发布台",
  material_library: "素材库",
  crossroad: "主路口",
  status_station: "状态站",
};

const EVENT_LABELS: Record<string, string> = {
  "wake.completed": "醒来",
  "move_to.completed": "移动完成",
  "work_on.completed": "工作完成",
  "work_on.failed": "工作失败",
  "work_on.cancelled": "工作取消",
  "artifact_created.completed": "产物登记",
  "sleep.completed": "休眠",
  "chat.message": "消息",
};

/** Pick a stable accent color from a name for the avatar background. */
const AVATAR_COLORS = ["#4f46e5", "#2563eb", "#0891b2", "#059669", "#d97706", "#dc2626", "#7c3aed"];
function pickAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

function isSameDay(iso: string, ref: Date): boolean {
  try {
    const d = new Date(iso);
    return (
      d.getFullYear() === ref.getFullYear() &&
      d.getMonth() === ref.getMonth() &&
      d.getDate() === ref.getDate()
    );
  } catch {
    return false;
  }
}

export function StatusPanel({ open, beingId, onClose }: StatusPanelProps) {
  const [being, setBeing] = useState<BeingInfo | null>(null);
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [logs, setLogs] = useState<ActionLogRecord[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const request = useMemo(() => createRequest(), []);
  // Task 17 (§9.4.5): full-screen Drawer on mobile (<768px).
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!open || !beingId) return;
    void getDigitalBeing(request, beingId).then(setBeing).catch(() => {});
    void listActions(request, beingId)
      .then((items) => setActions(items as ActionRecord[]))
      .catch(() => {});
    void listActionLogs(request, beingId)
      .then((items) => setLogs(items as ActionLogRecord[]))
      .catch(() => {});
    void listArtifacts(request, beingId)
      .then((items) => setArtifacts(items as ArtifactRecord[]))
      .catch(() => {});
  }, [open, beingId, request]);

  // ── Derived stats ──
  const todayRef = useMemo(() => new Date(), [open, beingId]);

  const completedToday = useMemo(() => {
    return logs.filter(
      (log) =>
        log.eventType.endsWith(".completed") &&
        isSameDay(log.createdAt, todayRef),
    ).length;
  }, [logs, todayRef]);

  const artifactsToday = useMemo(() => {
    return artifacts.filter((a) => isSameDay(a.createdAt, todayRef)).length;
  }, [artifacts, todayRef]);

  const runningAction = useMemo(
    () => actions.find((a) => a.status === "running"),
    [actions],
  );

  const recentLogs = useMemo(() => logs.slice(-10).reverse(), [logs]);

  const statusLabel = being ? (STATUS_LABELS[being.status] ?? being.status) : "—";

  return (
    <Drawer
      title={
        <div className="dw-panel-header">
          <DashboardOutlined className="dw-panel-header__icon" />
          <span className="dw-panel-header__title">状态</span>
        </div>
      }
      open={open}
      onClose={onClose}
      width={isMobile ? "100%" : 360}
    >
      <div className="status-panel">
        {/* ── Top: being identity card ── */}
        <Card className="status-panel__hero" bordered={false}>
          <div className="status-panel__hero-row">
            <Avatar
              size={56}
              style={{
                backgroundColor: being ? pickAvatarColor(being.name) : "#6b7280",
                fontSize: 22,
                fontWeight: 600,
              }}
            >
              {being ? being.name.slice(0, 1).toUpperCase() : "?"}
            </Avatar>
            <div className="status-panel__hero-info">
              <div className="status-panel__hero-name">
                {being?.name ?? "—"}
              </div>
              <Tag
                color={being ? (STATUS_COLORS[being.status] ?? "default") : "default"}
                className="status-panel__hero-status"
              >
                {statusLabel}
              </Tag>
            </div>
          </div>
          <div className="status-panel__hero-meta">
            <div className="status-panel__hero-meta-item">
              <span className="status-panel__meta-label">位置</span>
              <span className="status-panel__meta-value">
                {being ? (NODE_NAMES[being.currentNodeId] ?? being.currentNodeId) : "—"}
              </span>
            </div>
            <div className="status-panel__hero-meta-item">
              <span className="status-panel__meta-label">状态文本</span>
              <span className="status-panel__meta-value">
                {being?.statusText ?? "—"}
              </span>
            </div>
          </div>
        </Card>

        {/* ── Progress: shown only when a task is running ── */}
        {runningAction && (
          <Card className="status-panel__progress-card" bordered={false}>
            <div className="status-panel__progress-label">
              正在进行：{runningAction.type ?? runningAction.statusText ?? "任务"}
            </div>
            <Progress percent={70} status="active" />
          </Card>
        )}

        {/* ── Stats cards ── */}
        <div className="status-panel__stats">
          <Card className="status-panel__stat" bordered={false}>
            <Statistic title="今日完成" value={completedToday} />
          </Card>
          <Card className="status-panel__stat" bordered={false}>
            <Statistic title="产物数" value={artifacts.length} />
          </Card>
          <Card className="status-panel__stat" bordered={false}>
            <Statistic title="今日产物" value={artifactsToday} />
          </Card>
        </div>

        {/* ── Timeline of recent activities ── */}
        <Card
          className="status-panel__timeline-card"
          bordered={false}
          title={
            <span className="status-panel__section-title">
              <ClockCircleOutlined /> 最近活动
            </span>
          }
        >
          {recentLogs.length > 0 ? (
            <Timeline
              items={recentLogs.map((log) => ({
                children: (
                  <div className="status-panel__timeline-item">
                    <span className="status-panel__timeline-event">
                      {EVENT_LABELS[log.eventType] ?? log.eventType}
                    </span>
                    <span className="status-panel__timeline-time">
                      {new Date(log.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                ),
              }))}
            />
          ) : (
            <Empty description="暂无活动" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>
      </div>
    </Drawer>
  );
}
