import { Drawer, Timeline } from "antd";
import { HistoryOutlined } from "@ant-design/icons";
import { useState, useEffect, useMemo } from "react";
import { createRequest } from "../../../shared/api/client";
import { listActionLogs } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import "./ActionLogPanel.scss";

interface ActionLog {
  id: string;
  eventType: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

interface ActionLogPanelProps {
  open: boolean;
  beingId?: string;
  onClose: () => void;
}

const EVENT_LABELS: Record<string, string> = {
  "wake.completed": "醒来",
  "move_to.completed": "移动完成",
  "work_on.completed": "工作完成",
  "work_on.failed": "工作失败",
  "work_on.cancelled": "工作取消",
  "artifact_created.completed": "产物登记",
  "sleep.completed": "休眠",
};

export function ActionLogPanel({ open, beingId, onClose }: ActionLogPanelProps) {
  const [logs, setLogs] = useState<ActionLog[]>([]);
  const request = useMemo(() => createRequest(), []);
  // Task 17 (§9.4.5): full-screen Drawer on mobile (<768px).
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!open || !beingId) return;
    void listActionLogs(request, beingId)
      .then((items) => setLogs(items as ActionLog[]))
      .catch(() => {});
  }, [open, beingId, request]);

  return (
    <Drawer
      title={
        <div className="dw-panel-header">
          <HistoryOutlined className="dw-panel-header__icon" />
          <span className="dw-panel-header__title">动作日志</span>
        </div>
      }
      open={open}
      onClose={onClose}
      width={isMobile ? "100%" : 360}
    >
      <div className="action-log-panel">
        {logs.length > 0 ? (
          <Timeline
            items={logs.slice(-20).reverse().map((log) => ({
              children: (
                <div className="action-log-panel__item">
                  <span className="action-log-panel__event">
                    {EVENT_LABELS[log.eventType] ?? log.eventType}
                  </span>
                  {log.payload && Object.keys(log.payload).length > 0 && (
                    <span className="action-log-panel__detail">
                      {formatPayload(log.payload)}
                    </span>
                  )}
                  <span className="action-log-panel__time">
                    {new Date(log.createdAt).toLocaleTimeString()}
                  </span>
                </div>
              ),
            }))}
          />
        ) : (
          <div className="action-log-panel__empty">暂无日志</div>
        )}
      </div>
    </Drawer>
  );
}

function formatPayload(payload: Record<string, unknown>): string {
  const type = payload.type as string | undefined;
  if (type) return `(${type})`;
  return "";
}
