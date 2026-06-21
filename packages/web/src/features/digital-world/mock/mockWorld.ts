import type { WorldNodeData, WorldEdgeData, DigitalBeingData } from "../types";

/**
 * Mock 世界布局（十字路口结构）
 *
 *              [素材库]
 *                 |
 * [家 Home] — [主路口] — [视频工作台] — [产物箱]
 *                 |
 *          [TikTok 发布台]
 *                 |
 *           [日志/状态区]
 */

const CX = 500;
const CY = 350;
const SPREAD = 1.5; // 放大节点间距

export const mockNodes: WorldNodeData[] = [
  {
    id: "home",
    type: "home",
    name: "家",
    position: { x: CX - 300 * SPREAD, y: CY },
    size: { width: 120, height: 100 },
    logo: "home",
  },
  {
    id: "crossroad",
    type: "status_station",
    name: "主路口",
    position: { x: CX, y: CY },
    size: { width: 90, height: 70 },
  },
  {
    id: "video_workstation",
    type: "video_workstation",
    name: "视频工作台",
    position: { x: CX + 220 * SPREAD, y: CY },
    size: { width: 140, height: 100 },
    logo: "video",
  },
  {
    id: "artifact_box",
    type: "artifact_box",
    name: "产物箱",
    position: { x: CX + 440 * SPREAD, y: CY },
    size: { width: 120, height: 100 },
    logo: "box",
  },
  {
    id: "tiktok_station",
    type: "tiktok_station",
    name: "TikTok 发布台",
    position: { x: CX, y: CY + 180 * SPREAD },
    size: { width: 140, height: 100 },
    logo: "tiktok",
  },
  {
    id: "material_library",
    type: "material_library",
    name: "素材库",
    position: { x: CX, y: CY - 180 * SPREAD },
    size: { width: 120, height: 100 },
    logo: "material",
  },
  {
    id: "log_station",
    type: "status_station",
    name: "日志/状态区",
    position: { x: CX, y: CY + 360 * SPREAD },
    size: { width: 140, height: 100 },
  },
];

export const mockEdges: WorldEdgeData[] = [
  { id: "e_home_cross", fromNodeId: "home", toNodeId: "crossroad", distance: 1, bidirectional: true },
  { id: "e_cross_video", fromNodeId: "crossroad", toNodeId: "video_workstation", distance: 1, bidirectional: true },
  { id: "e_video_artifact", fromNodeId: "video_workstation", toNodeId: "artifact_box", distance: 1, bidirectional: true },
  { id: "e_cross_tiktok", fromNodeId: "crossroad", toNodeId: "tiktok_station", distance: 1, bidirectional: true },
  { id: "e_cross_material", fromNodeId: "crossroad", toNodeId: "material_library", distance: 1, bidirectional: true },
  { id: "e_tiktok_log", fromNodeId: "tiktok_station", toNodeId: "log_station", distance: 1, bidirectional: true },
];

export const mockBeing: DigitalBeingData = {
  id: "being-1",
  name: "小 P",
  currentNodeId: "home",
  status: "idle",
  statusText: "空闲",
};
