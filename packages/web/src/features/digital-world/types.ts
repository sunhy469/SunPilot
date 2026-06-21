export interface WorldNodeData {
  id: string;
  type:
    | "home"
    | "video_workstation"
    | "artifact_box"
    | "tiktok_station"
    | "material_library"
    | "status_station";
  name: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  icon?: string;
  logo?: "tiktok" | "video" | "box" | "home" | "material";
}

export interface WorldEdgeData {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  distance: number;
  bidirectional: boolean;
  locked?: boolean;
}

export interface DigitalBeingData {
  id: string;
  name: string;
  currentNodeId: string;
  status: "idle" | "moving" | "working" | "waiting" | "publishing" | "sleeping" | "error";
  statusText: string;
  sleepReason?: "task_done" | "budget_exhausted" | "waiting_user" | "cooldown" | "manual";
}
