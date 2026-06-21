import { Drawer, Descriptions, Tag } from "antd";
import { useState, useEffect, useMemo } from "react";
import { createRequest } from "../../../shared/api/client";
import {
  getDigitalBeing,
  listActions,
  type BeingInfo,
} from "../api";
import "./StatusPanel.scss";

interface ActionRecord {
  id: string;
  status: string;
  type?: string;
  statusText?: string;
  [key: string]: unknown;
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
};

const NODE_NAMES: Record<string, string> = {
  home: "家",
  video_workstation: "视频工作台",
  artifact_box: "产物箱",
  tiktok_station: "TikTok 发布台",
  material_library: "素材库",
  crossroad: "主路口",
};

export function StatusPanel({ open, beingId, onClose }: StatusPanelProps) {
  const [being, setBeing] = useState<BeingInfo | null>(null);
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const request = useMemo(() => createRequest(), []);

  useEffect(() => {
    if (!open || !beingId) return;
    void getDigitalBeing(request, beingId).then(setBeing).catch(() => {});
    void listActions(request, beingId)
      .then((items) => setActions(items as ActionRecord[]))
      .catch(() => {});
  }, [open, beingId, request]);

  return (
    <Drawer title="状态" open={open} onClose={onClose} width={360}>
      <div className="status-panel">
        {being && (
          <Descriptions column={1} size="small">
            <Descriptions.Item label="名称">{being.name}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_COLORS[being.status] ?? "default"}>{being.status}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="位置">{NODE_NAMES[being.currentNodeId] ?? being.currentNodeId}</Descriptions.Item>
            <Descriptions.Item label="状态文本">{being.statusText ?? "-"}</Descriptions.Item>
          </Descriptions>
        )}

        <div className="status-panel__actions">
          <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "#374151" }}>当前动作</h4>
          {actions.length > 0 ? (
            actions.map((action) => (
              <div key={action.id} className="status-panel__action-item">
                <span>{action.type ?? String(action.id)}</span>
                <Tag color={STATUS_COLORS[action.status] ?? "default"}>{action.status}</Tag>
              </div>
            ))
          ) : (
            <div className="status-panel__empty">暂无动作</div>
          )}
        </div>
      </div>
    </Drawer>
  );
}
