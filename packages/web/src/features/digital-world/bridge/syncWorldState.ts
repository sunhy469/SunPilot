import type { WorldApp } from "../canvas/WorldApp";
import type { WorldNodeData, WorldEdgeData, DigitalBeingData } from "../types";

export interface SyncWorldStateOptions {
  worldApp: WorldApp;
  intervalMs?: number;
}

export function startWorldStateSync(
  fetchState: () => Promise<{
    nodes: WorldNodeData[];
    edges: WorldEdgeData[];
    being: DigitalBeingData;
  } | null>,
  options: SyncWorldStateOptions,
): () => void {
  const { worldApp, intervalMs = 3000 } = options;
  let running = true;

  const poll = async () => {
    if (!running) return;

    try {
      const state = await fetchState();
      if (!state) return;

      // Update being position and status if changed
      const currentBeing = worldApp.beingData;
      if (state.being.currentNodeId !== currentBeing.currentNodeId) {
        worldApp.updateBeingPosition(state.being.currentNodeId);
      }
      if (state.being.statusText !== currentBeing.statusText) {
        worldApp.updateBeingStatus(state.being.statusText);
      }
    } catch {
      // Ignore fetch errors, will retry on next poll
    }

    if (running) {
      setTimeout(poll, intervalMs);
    }
  };

  void poll();

  return () => {
    running = false;
  };
}
