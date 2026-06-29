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
import { CreateFirstBeing } from "./components/CreateFirstBeing";
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
  // refreshKey is incremented after a being is created to trigger a re-fetch
  // of the world state, transitioning from the creation guide to normal view.
  const [refreshKey, setRefreshKey] = useState(0);
  const { nodes, edges, being, beings, loaded, isMock, error, needsBeing } =
    useDigitalWorldBootstrap(refreshKey);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  // Task 10: track the being selected via canvas click (null = primary).
  const [selectedBeingId, setSelectedBeingId] = useState<string | null>(null);

  const worldData = useMemo(
    () => (loaded ? { nodes, edges, being, beings } : undefined),
    [loaded, nodes, edges, being, beings],
  );

  const worldRef = useWorldApp(canvasHostRef, worldData);
  const { triggerMoveTo } = useBeingMovement(worldRef);
  const request = useMemo(() => createRequest(), []);

  // Task 10: the being currently targeted by panels = selected or primary.
  const activeBeing = useMemo(() => {
    if (selectedBeingId) {
      return beings.find((b) => b.id === selectedBeingId) ?? being;
    }
    return being;
  }, [beings, selectedBeingId, being]);

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

    world.onBeingClick = (beingId: string) => {
      // Task 10: select the clicked being and open its status panel.
      setSelectedBeingId(beingId);
      world.selectBeing(beingId);
      setStatusPanelOpen(true);
    };
  }, [worldRef, loaded]);

  const handleWakeSleep = useCallback(async () => {
    if (!activeBeing?.id) return;
    try {
      if (activeBeing.status === "sleeping") {
        await request(endpoints.digitalBeingWake(activeBeing.id), { method: "POST" });
        message.success("已唤醒数字生命");
      } else {
        await request(endpoints.digitalBeingSleep(activeBeing.id), { method: "POST", body: JSON.stringify({ reason: "manual" }) });
        message.success("数字生命已休眠");
      }
    } catch {
      message.error("操作失败");
    }
  }, [activeBeing, request]);

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

  // Task 14 (§9.5.7): keyboard shortcuts.
  //   F      — fit/center on the active being
  //   H      — send the being home
  //   1..5   — open Task / Artifact / Chat / Status / Log panels
  //   Space  — pause / resume canvas animations
  //   + / -  — zoom in / out
  // Shortcuts are ignored while typing in inputs/textareas so the chat box
  // and panel search fields keep working normally.
  const animationPausedRef = useRef(false);
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const world = worldRef.current;
      switch (e.key) {
        case "f":
        case "F":
          world?.centerOnBeing();
          break;
        case "h":
        case "H":
          // Go home — move the being to the home node.
          triggerMoveTo("home");
          break;
        case "1":
          setTaskPanelOpen(true);
          break;
        case "2":
          setArtifactPanelOpen(true);
          break;
        case "3":
          setChatPanelOpen(true);
          break;
        case "4":
          setStatusPanelOpen(true);
          break;
        case "5":
          setLogPanelOpen(true);
          break;
        case " ":
          // Prevent the page from scrolling when toggling pause.
          e.preventDefault();
          animationPausedRef.current = !animationPausedRef.current;
          world?.setAnimationPaused(animationPausedRef.current);
          message.info(animationPausedRef.current ? "动画已暂停" : "动画已恢复", 0.8);
          break;
        case "+":
        case "=":
          world?.zoom(1);
          break;
        case "-":
        case "_":
          world?.zoom(-1);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    // Capture the current world instance at effect setup time — by the time
    // cleanup runs the ref may have been reassigned (or null during unmount).
    const worldAtSetup = worldRef.current;
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      // Ensure animations are running when the component unmounts.
      worldAtSetup?.setAnimationPaused(false);
    };
  }, [worldRef, triggerMoveTo]);

  // §9.4.1: derive the currently active panel key (for the dock's dot
  // indicator). Only one dot is shown; when multiple panels are open the
  // first in dock order wins.
  const activePanel = useMemo(() => {
    if (statusPanelOpen) return "status";
    if (artifactPanelOpen) return "artifacts";
    if (chatPanelOpen) return "chat";
    if (taskPanelOpen) return "tasks";
    if (logPanelOpen) return "logs";
    return undefined;
  }, [statusPanelOpen, artifactPanelOpen, chatPanelOpen, taskPanelOpen, logPanelOpen]);

  return (
    <section className="digital-world">
      <div ref={canvasHostRef} className="digital-world__canvas-host" />
      {needsBeing && loaded && !isMock && (
        <CreateFirstBeing
          nodes={nodes}
          request={request}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {!loaded && (
        <div className="digital-world__loading">
          <div className="digital-world__loading-spinner" />
          <span className="digital-world__loading-text">正在加载数字世界…</span>
        </div>
      )}
      {isMock && loaded && (
        <div className="digital-world__mock-badge">DEV MOCK</div>
      )}
      {error && loaded && !isMock && (
        <div className="digital-world__error-banner">{error}</div>
      )}
      <WorldFloatingDock
        onAction={handleDockAction}
        activePanel={activePanel}
        beingStatus={being?.status}
      />
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
      <TaskPanel open={taskPanelOpen} beingId={activeBeing?.id} onClose={() => setTaskPanelOpen(false)} />
      <ArtifactBoxPanel open={artifactPanelOpen} beingId={activeBeing?.id} onClose={() => setArtifactPanelOpen(false)} />
      <BeingChatPanel open={chatPanelOpen} beingId={activeBeing?.id} beingName={activeBeing?.name} request={request} onClose={() => setChatPanelOpen(false)} />
      <StatusPanel open={statusPanelOpen} beingId={activeBeing?.id} onClose={() => setStatusPanelOpen(false)} />
      <ActionLogPanel open={logPanelOpen} beingId={activeBeing?.id} onClose={() => setLogPanelOpen(false)} />
    </section>
  );
}
