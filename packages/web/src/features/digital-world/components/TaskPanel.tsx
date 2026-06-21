import { Drawer, Button, Space, Tag } from "antd";
import { useState, useEffect, useMemo, useCallback } from "react";
import { createRequest } from "../../../shared/api/client";
import { listTasks, createTask } from "../api";
import "./TaskPanel.scss";

interface TaskRecord {
  id: string;
  beingId: string;
  type: string;
  status: string;
  title: string;
  input: Record<string, unknown>;
  createdAt: string;
}

interface TaskPanelProps {
  open: boolean;
  beingId?: string;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  queued: "default",
  running: "processing",
  completed: "success",
  failed: "error",
  waiting: "warning",
  cancelled: "default",
};

export function TaskPanel({ open, beingId, onClose }: TaskPanelProps) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const request = useMemo(() => createRequest(), []);

  const refreshTasks = useCallback(() => {
    if (!beingId) return;
    void listTasks(request, beingId)
      .then((items) => setTasks(items as TaskRecord[]))
      .catch(() => {});
  }, [beingId, request]);

  useEffect(() => {
    if (!open || !beingId) return;
    refreshTasks();
  }, [open, beingId, refreshTasks]);

  const handleCreateTask = (type: string, title: string) => {
    if (!beingId) return;
    void createTask(request, beingId, { type, title })
      .then(() => refreshTasks())
      .catch(() => {});
  };

  return (
    <Drawer title="任务" open={open} onClose={onClose} width={360}>
      <div className="task-panel">
        <div className="task-panel__actions">
          <Space direction="vertical" style={{ width: "100%" }}>
            <Button block onClick={() => handleCreateTask("make_and_publish_video", "制作视频并发布到 TikTok")}>
              制作视频并发布
            </Button>
            <Button block onClick={() => handleCreateTask("make_video", "制作视频")}>
              制作视频
            </Button>
            <Button block onClick={() => handleCreateTask("return_home", "回家")}>
              回家
            </Button>
          </Space>
        </div>

        <div className="task-panel__list">
          {tasks.map((task) => (
            <div key={task.id} className="task-panel__item">
              <div className="task-panel__item-header">
                <span>{task.title}</span>
                <Tag color={STATUS_COLORS[task.status] ?? "default"}>{task.status}</Tag>
              </div>
              <div className="task-panel__item-time">
                {new Date(task.createdAt).toLocaleString()}
              </div>
            </div>
          ))}
          {tasks.length === 0 && (
            <div className="task-panel__empty">暂无任务</div>
          )}
        </div>
      </div>
    </Drawer>
  );
}
