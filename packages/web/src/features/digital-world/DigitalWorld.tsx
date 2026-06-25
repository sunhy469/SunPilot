import { useRef, useMemo, useState, useCallback, useEffect } from "react";
import { message, Button } from "antd";
import { AimOutlined } from "@ant-design/icons";
import { useWorldApp } from "./hooks/useWorldApp";
import { useBeingMovement } from "./hooks/useBeingMovement";
import { useDigitalWorldBootstrap } from "./hooks/useDigitalWorldBootstrap";
import { WorldFloatingDock } from "./components/WorldFloatingDock";
import { MovementTestBar } from "./components/MovementTestBar";
import { TaskPanel } from "./components/TaskPanel";
import { ArtifactBoxPanel } from "./components/ArtifactBoxPanel";
import { BeingChatPanel } from "./components/BeingChatPanel";
import { StatusPanel } from "./components/StatusPanel";
import { ActionLogPanel } from "./components/ActionLogPanel";
import { createRequest } from "../../shared/api/client";
import { endpoints } from "../../shared/api/endpoints";
import "./DigitalWorld.scss";

/** Node ID → panel mapping for click interactions */
const NODE_PANEL_MAP: Record<string, "artifacts" | "tasks" | "status" | "chat"> = {
  artifact_box: "artifacts",
  video_workstation: "tasks",
  tiktok_station: "tasks",
  material_library: "tasks",
  home: "status",
  log_station: "status",
};

export function DigitalWorld() {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const { nodes, edges, being, loaded, isMock } = useDigitalWorldBootstrap();
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const [logPanelOpen, setLogPanelOpen] = useState(false);

  const worldData = useMemo(
    () => (loaded ? { nodes, edges, being } : undefined),
    [loaded, nodes, edges, being],
  );

  const worldRef = useWorldApp(canvasHostRef, worldData);
  const { triggerMoveTo } = useBeingMovement(worldRef);
  const request = useMemo(() => createRequest(), []);

  // Wire up world object click handlers
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;

    world.onNodeClick = (nodeId: string) => {
      const panel = NODE_PANEL_MAP[nodeId];
      if (panel === "artifacts") setArtifactPanelOpen(true);
      else if (panel === "tasks") setTaskPanelOpen(true);
      else if (panel === "status") setStatusPanelOpen(true);
      else if (panel === "chat") setChatPanelOpen(true);
    };

    world.onBeingClick = (_beingId: string) => {
      setStatusPanelOpen(true);
    };
  }, [worldRef, loaded]);

  const handleWakeSleep = useCallback(async () => {
    if (!being?.id) return;
    try {
      if (being.status === "sleeping") {
        await request(endpoints.digitalBeingWake(being.id), { method: "POST" });
        message.success("已唤醒数字生命");
      } else {
        await request(endpoints.digitalBeingSleep(being.id), { method: "POST", body: JSON.stringify({ reason: "manual" }) });
        message.success("数字生命已休眠");
      }
    } catch {
      message.error("操作失败");
    }
  }, [being, request]);

  const handleDockAction = useCallback((key: string) => {
    switch (key) {
      case "status": setStatusPanelOpen(true); break;
      case "artifacts": setArtifactPanelOpen(true); break;
      case "chat": setChatPanelOpen(true); break;
      case "tasks": setTaskPanelOpen(true); break;
      case "logs": setLogPanelOpen(true); break;
      case "settings": message.info("设置功能开发中"); break;
      case "wake-sleep": handleWakeSleep(); break;
    }
  }, [handleWakeSleep]);

  const handleLocateBeing = useCallback(() => {
    worldRef.current?.centerOnBeing();
  }, [worldRef]);

  return (
    <section className="digital-world">
      <div ref={canvasHostRef} className="digital-world__canvas-host" />
      {isMock && loaded && (
        <div className="digital-world__mock-badge">DEV MOCK</div>
      )}
      <WorldFloatingDock onAction={handleDockAction} />
      {/* Locate being button — always visible */}
      <Button
        className="digital-world__locate-btn"
        icon={<AimOutlined />}
        size="small"
        onClick={handleLocateBeing}
        title="定位数字生命"
      />
      {/* MovementTestBar — dev only */}
      {import.meta.env.DEV && <MovementTestBar onMoveTo={triggerMoveTo} />}
      <TaskPanel open={taskPanelOpen} beingId={being?.id} onClose={() => setTaskPanelOpen(false)} />
      <ArtifactBoxPanel open={artifactPanelOpen} beingId={being?.id} onClose={() => setArtifactPanelOpen(false)} />
      <BeingChatPanel open={chatPanelOpen} beingId={being?.id} beingName={being?.name} request={request} onClose={() => setChatPanelOpen(false)} />
      <StatusPanel open={statusPanelOpen} beingId={being?.id} onClose={() => setStatusPanelOpen(false)} />
      <ActionLogPanel open={logPanelOpen} beingId={being?.id} onClose={() => setLogPanelOpen(false)} />
    </section>
  );
}
