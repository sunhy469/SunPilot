import { useEffect, useState, useMemo } from "react";
import { createRequest } from "../../../shared/api/client";
import { getWorldState, type WorldStateResponse } from "../api";
import { mockNodes, mockEdges, mockBeing } from "../mock/mockWorld";
import type { WorldNodeData, WorldEdgeData, DigitalBeingData } from "../types";

const IS_DEV = import.meta.env.DEV ?? false;

export interface BootstrapData {
  nodes: WorldNodeData[];
  edges: WorldEdgeData[];
  being: DigitalBeingData;
  loaded: boolean;
  /** Whether the data comes from mock fallback (no real backend data). */
  isMock: boolean;
}

function mapApiToNodes(apiNodes: WorldStateResponse["nodes"]): WorldNodeData[] {
  return apiNodes.map((n) => ({
    id: n.id,
    type: n.type as WorldNodeData["type"],
    name: n.name,
    position: { x: n.posX, y: n.posY },
    size: { width: n.sizeWidth, height: n.sizeHeight },
    icon: n.icon,
    logo: n.logo as WorldNodeData["logo"],
  }));
}

function mapApiToEdges(apiEdges: WorldStateResponse["edges"]): WorldEdgeData[] {
  return apiEdges.map((e) => ({
    id: e.id,
    fromNodeId: e.fromNodeId,
    toNodeId: e.toNodeId,
    distance: e.distance,
    bidirectional: e.bidirectional,
    locked: e.locked,
  }));
}

function mapApiToBeing(apiBeings: WorldStateResponse["beings"]): DigitalBeingData | null {
  const b = apiBeings[0];
  if (!b) return null;
  return {
    id: b.id,
    name: b.name,
    currentNodeId: b.currentNodeId,
    status: b.status as DigitalBeingData["status"],
    statusText: b.statusText ?? "空闲",
    sleepReason: b.sleepReason as DigitalBeingData["sleepReason"],
  };
}

export function useDigitalWorldBootstrap(): BootstrapData {
  const [data, setData] = useState<BootstrapData>({
    nodes: mockNodes,
    edges: mockEdges,
    being: { ...mockBeing },
    loaded: false,
    isMock: true,
  });

  const request = useMemo(() => createRequest(), []);

  useEffect(() => {
    let cancelled = false;

    void request<WorldStateResponse>("/v1/digital-world")
      .then((result) => {
        if (cancelled) return;

        const nodes = mapApiToNodes(result.nodes);
        const edges = mapApiToEdges(result.edges);
        const being = mapApiToBeing(result.beings);

        if (nodes.length > 0 && being) {
          setData({ nodes, edges, being, loaded: true, isMock: false });
        } else {
          // Fallback to mock data only in DEV mode.
          // In production, show empty state to avoid masking backend issues.
          if (IS_DEV) {
            setData({
              nodes: mockNodes,
              edges: mockEdges,
              being: { ...mockBeing },
              loaded: true,
              isMock: true,
            });
          } else {
            setData((prev) => ({ ...prev, loaded: true, isMock: false }));
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        // API unavailable — use mock only in DEV mode
        if (IS_DEV) {
          setData({
            nodes: mockNodes,
            edges: mockEdges,
            being: { ...mockBeing },
            loaded: true,
            isMock: true,
          });
        } else {
          setData((prev) => ({ ...prev, loaded: true, isMock: false }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [request]);

  useWorldStatePolling(data.loaded, request, setData);

  return data;
}

// Polling effect: re-fetch world state periodically after initial load
function useWorldStatePolling(
  loaded: boolean,
  request: <T>(url: string) => Promise<T>,
  setData: React.Dispatch<React.SetStateAction<BootstrapData>>,
) {
  useEffect(() => {
    if (!loaded) return;

    const interval = setInterval(async () => {
      try {
        const result = await request<WorldStateResponse>("/v1/digital-world");
        const nodes = mapApiToNodes(result.nodes);
        const edges = mapApiToEdges(result.edges);
        const being = mapApiToBeing(result.beings);
        if (nodes.length > 0 && being) {
          setData({ nodes, edges, being, loaded: true, isMock: false });
        }
      } catch {
        // Ignore fetch errors, will retry on next poll
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [loaded, request, setData]);
}
