import { Drawer, List, Tag, Empty } from "antd";
import { useState, useEffect, useMemo } from "react";
import { createRequest } from "../../../shared/api/client";
import { listArtifacts } from "../api";
import "./ArtifactBoxPanel.scss";

interface ArtifactRecord {
  id: string;
  type: string;
  title: string;
  status: string;
  uri?: string;
  createdAt: string;
}

interface ArtifactBoxPanelProps {
  open: boolean;
  beingId?: string;
  onClose: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  video: "视频",
  image: "图片",
  script: "脚本",
  report: "报告",
  publish_result: "发布结果",
};

const STATUS_COLORS: Record<string, string> = {
  created: "default",
  stored: "processing",
  carried: "warning",
  published: "success",
  failed: "error",
};

export function ArtifactBoxPanel({ open, beingId, onClose }: ArtifactBoxPanelProps) {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const request = useMemo(() => createRequest(), []);

  useEffect(() => {
    if (!open || !beingId) return;
    void listArtifacts(request, beingId)
      .then((items) => setArtifacts(items as ArtifactRecord[]))
      .catch(() => {});
  }, [open, beingId, request]);

  return (
    <Drawer title="产物箱" open={open} onClose={onClose} width={360}>
      <div className="artifact-box-panel">
        {artifacts.length === 0 ? (
          <Empty description="暂无产物" />
        ) : (
          <List
            dataSource={artifacts}
            renderItem={(item) => (
              <List.Item>
                <div className="artifact-box-panel__item">
                  <div className="artifact-box-panel__item-header">
                    <span className="artifact-box-panel__item-title">{item.title}</span>
                    <Tag color={STATUS_COLORS[item.status] ?? "default"}>{item.status}</Tag>
                  </div>
                  <div className="artifact-box-panel__item-meta">
                    <Tag>{TYPE_LABELS[item.type] ?? item.type}</Tag>
                    <span className="artifact-box-panel__item-time">
                      {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              </List.Item>
            )}
          />
        )}
      </div>
    </Drawer>
  );
}
