import type { DatabaseContext } from "@sunpilot/storage";
import type { PlatformRequestContext } from "../context.js";
import type { WorldStateResult } from "./digital-world.types.js";

export class WorldService {
  constructor(private readonly deps: { database: DatabaseContext }) {}

  async getWorldState(_context: PlatformRequestContext): Promise<WorldStateResult> {
    const [nodes, edges, beings] = await Promise.all([
      this.deps.database.worldNodes.list(),
      this.deps.database.worldEdges.list(),
      this.deps.database.digitalBeings.list(),
    ]);
    return { nodes, edges, beings };
  }

  async listNodes(_context: PlatformRequestContext) {
    return this.deps.database.worldNodes.list();
  }

  async seedDefaultWorld(_context: PlatformRequestContext) {
    const existing = await this.deps.database.worldNodes.list();
    if (existing.length > 0) return;

    const CX = 500;
    const CY = 350;

    const nodes = [
      { id: "home", type: "home", name: "家", posX: CX - 200, posY: CY, sizeWidth: 100, sizeHeight: 80, logo: "home" },
      { id: "crossroad", type: "status_station", name: "主路口", posX: CX, posY: CY, sizeWidth: 80, sizeHeight: 60 },
      { id: "video_workstation", type: "video_workstation", name: "视频工作台", posX: CX + 200, posY: CY, sizeWidth: 120, sizeHeight: 80, logo: "video" },
      { id: "artifact_box", type: "artifact_box", name: "产物箱", posX: CX + 400, posY: CY, sizeWidth: 100, sizeHeight: 80, logo: "box" },
      { id: "tiktok_station", type: "tiktok_station", name: "TikTok 发布台", posX: CX, posY: CY + 160, sizeWidth: 120, sizeHeight: 80, logo: "tiktok" },
      { id: "material_library", type: "material_library", name: "素材库", posX: CX, posY: CY - 160, sizeWidth: 100, sizeHeight: 80, logo: "material" },
    ] as const;

    const edges = [
      { id: "e_home_cross", fromNodeId: "home", toNodeId: "crossroad", bidirectional: true },
      { id: "e_cross_video", fromNodeId: "crossroad", toNodeId: "video_workstation", bidirectional: true },
      { id: "e_video_artifact", fromNodeId: "video_workstation", toNodeId: "artifact_box", bidirectional: true },
      { id: "e_cross_tiktok", fromNodeId: "crossroad", toNodeId: "tiktok_station", bidirectional: true },
      { id: "e_cross_material", fromNodeId: "crossroad", toNodeId: "material_library", bidirectional: true },
    ] as const;

    await Promise.all(nodes.map((node) => this.deps.database.worldNodes.create(node)));
    await Promise.all(edges.map((edge) => this.deps.database.worldEdges.create(edge)));
  }
}
