import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { createRequest } from "../../../shared/api/client";
import { type WorldStateResponse } from "../api";
import { mockNodes, mockEdges, mockBeing } from "../mock/mockWorld";
import type { WorldNodeData, WorldEdgeData, DigitalBeingData } from "../types";

const IS_DEV = import.meta.env.DEV ?? false;

export interface BootstrapData {
  nodes: WorldNodeData[];
  edges: WorldEdgeData[];
  /** Primary being (first in the list). Kept for backwards compatibility. */
  being: DigitalBeingData;
  /** Task 10 (§9.5.2): all beings in the world. */
  beings: DigitalBeingData[];
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

/** Task 10 (§9.5.2): map ALL beings from the API (was singleton apiBeings[0]). */
function mapApiToBeings(apiBeings: WorldStateResponse["beings"]): DigitalBeingData[] {
  return apiBeings.map((b) => ({
    id: b.id,
    name: b.name,
    currentNodeId: b.currentNodeId,
    status: b.status as DigitalBeingData["status"],
    statusText: b.statusText ?? "空闲",
    sleepReason: b.sleepReason as DigitalBeingData["sleepReason"],
  }));
}

/** §9.5.1: Fetch the world state and apply it to the BootstrapData state.
 *  Shared by the initial fetch, the HTTP polling fallback, and the WebSocket
 *  `world.state.changed` handler so all three paths use identical mapping. */
async function fetchAndApplyWorldState(
  request: <T>(url: string) => Promise<T>,
  setData: React.Dispatch<React.SetStateAction<BootstrapData>>,
  options?: { allowMockFallback?: boolean },
): Promise<void> {
  try {
    const result = await request<WorldStateResponse>("/v1/digital-world");
    const nodes = mapApiToNodes(result.nodes);
    const edges = mapApiToEdges(result.edges);
    const beings = mapApiToBeings(result.beings);
    const being = beings[0];
    if (nodes.length > 0 && being) {
      setData({ nodes, edges, being, beings, loaded: true, isMock: false });
      return;
    }
    // Empty world state — keep existing data (no spurious overwrite).
    if (!options?.allowMockFallback) {
      setData((prev) => ({ ...prev, loaded: true, isMock: false }));
    }
  } catch {
    // Ignore fetch errors; callers (polling / WS) will retry.
  }
}

/** DEV-only mock fallback used by the initial fetch when the backend is
 *  unavailable. Mirrors the original behaviour. */
function mockFallbackData(): BootstrapData {
  return {
    nodes: mockNodes,
    edges: mockEdges,
    being: { ...mockBeing },
    beings: [{ ...mockBeing }],
    loaded: true,
    isMock: true,
  };
}

export function useDigitalWorldBootstrap(): BootstrapData {
  const [data, setData] = useState<BootstrapData>({
    nodes: mockNodes,
    edges: mockEdges,
    being: { ...mockBeing },
    beings: [{ ...mockBeing }],
    loaded: false,
    isMock: true,
  });

  const request = useMemo(() => createRequest(), []);

  // §9.5.1: subscribe to the shared WebSocket for realtime world.state.changed
  // events. When connected, the HTTP polling interval is stretched (fallback).
  const { subscribe, connected } = useDigitalWorldSocket();

  // Initial fetch.
  useEffect(() => {
    let cancelled = false;

    void request<WorldStateResponse>("/v1/digital-world")
      .then((result) => {
        if (cancelled) return;

        const nodes = mapApiToNodes(result.nodes);
        const edges = mapApiToEdges(result.edges);
        const beings = mapApiToBeings(result.beings);
        const being = beings[0];

        if (nodes.length > 0 && being) {
          setData({ nodes, edges, being, beings, loaded: true, isMock: false });
        } else {
          // Fallback to mock data only in DEV mode.
          // In production, show empty state to avoid masking backend issues.
          if (IS_DEV) {
            setData(mockFallbackData());
          } else {
            setData((prev) => ({ ...prev, loaded: true, isMock: false }));
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        // API unavailable — use mock only in DEV mode
        if (IS_DEV) {
          setData(mockFallbackData());
        } else {
          setData((prev) => ({ ...prev, loaded: true, isMock: false }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [request]);

  // §9.5.1: HTTP polling fallback. Runs at a reduced frequency when the
  // WebSocket is connected (the WS pushes incremental updates in real time).
  useWorldStatePolling(data.loaded, request, setData, connected);

  // §9.5.1: WebSocket subscription — on `world.state.changed`, re-fetch the
  // world state immediately. The backend may or may not emit this event;
  // polling remains as a fallback either way.
  useEffect(() => {
    if (!data.loaded) return;
    return subscribe((message) => {
      const msg = message as { method?: string };
      if (msg && msg.method === "world.state.changed") {
        void fetchAndApplyWorldState(request, setData);
      }
    });
  }, [data.loaded, request, setData, subscribe]);

  return data;
}

// ── §9.5.1: shared WebSocket connection ──────────────────────────────────
//
// A module-level singleton WebSocket shared between useDigitalWorldBootstrap
// (world.state.changed) and BeingChatPanel (chat responses). Ref-counted so
// the connection is closed only when the last consumer releases it. Auto-
// reconnects with a backoff when the socket drops.

type SocketMessageListener = (message: unknown) => void;

let worldSocket: WebSocket | null = null;
let worldSocketRefCount = 0;
let worldSocketReconnectTimer: ReturnType<typeof setTimeout> | null = null;
const worldSocketListeners = new Set<SocketMessageListener>();
let worldSocketConnected = false;
const worldSocketConnectedListeners = new Set<(connected: boolean) => void>();

function notifyConnectedListeners(): void {
  for (const listener of worldSocketConnectedListeners) {
    listener(worldSocketConnected);
  }
}

function worldSocketConnect(): void {
  if (worldSocket) return;
  if (typeof window === "undefined") return; // SSR guard.
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/v1/ws`;
  try {
    worldSocket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  worldSocket.onopen = () => {
    worldSocketConnected = true;
    notifyConnectedListeners();
  };
  worldSocket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      for (const listener of worldSocketListeners) {
        listener(message);
      }
    } catch {
      // ignore non-JSON / malformed messages
    }
  };
  worldSocket.onclose = () => {
    worldSocket = null;
    if (worldSocketConnected) {
      worldSocketConnected = false;
      notifyConnectedListeners();
    }
    scheduleReconnect();
  };
  worldSocket.onerror = () => {
    // onclose will follow; nothing to do here.
  };
}

function scheduleReconnect(): void {
  if (worldSocketReconnectTimer || worldSocketRefCount === 0) return;
  worldSocketReconnectTimer = setTimeout(() => {
    worldSocketReconnectTimer = null;
    worldSocketConnect();
  }, 5000);
}

function worldSocketAcquire(): void {
  worldSocketRefCount++;
  if (worldSocketReconnectTimer) {
    clearTimeout(worldSocketReconnectTimer);
    worldSocketReconnectTimer = null;
  }
  worldSocketConnect();
}

function worldSocketRelease(): void {
  worldSocketRefCount = Math.max(0, worldSocketRefCount - 1);
  if (worldSocketRefCount === 0) {
    if (worldSocketReconnectTimer) {
      clearTimeout(worldSocketReconnectTimer);
      worldSocketReconnectTimer = null;
    }
    if (worldSocket) {
      worldSocket.onclose = null; // suppress reconnect on intentional close
      worldSocket.onopen = null;
      worldSocket.onmessage = null;
      worldSocket.onerror = null;
      try {
        worldSocket.close();
      } catch {
        // ignore
      }
      worldSocket = null;
    }
    if (worldSocketConnected) {
      worldSocketConnected = false;
      notifyConnectedListeners();
    }
  }
}

export interface DigitalWorldSocket {
  /** Register a handler for parsed WebSocket messages. Returns an unsubscribe
   *  function. Replacing the handler is supported (the previous one is
   *  removed). */
  subscribe(listener: SocketMessageListener): () => void;
  /** Whether the shared socket is currently in the OPEN state. */
  connected: boolean;
}

/**
 * §9.5.1: acquire a handle to the shared digital-world WebSocket. The
 * connection is ref-counted across all callers; it stays open while at least
 * one component is subscribed and auto-closes when the last one unmounts.
 */
export function useDigitalWorldSocket(): DigitalWorldSocket {
  const [connected, setConnected] = useState(worldSocketConnected);
  const listenerRef = useRef<SocketMessageListener | null>(null);

  useEffect(() => {
    worldSocketAcquire();
    const onConnected = (next: boolean) => {
      setConnected((prev) => (prev === next ? prev : next));
    };
    worldSocketConnectedListeners.add(onConnected);
    // Sync initial state (the socket may already be open from another caller).
    setConnected(worldSocketConnected);

    return () => {
      worldSocketConnectedListeners.delete(onConnected);
      if (listenerRef.current) {
        worldSocketListeners.delete(listenerRef.current);
        listenerRef.current = null;
      }
      worldSocketRelease();
      setConnected(false);
    };
  }, []);

  const subscribe = useCallback((listener: SocketMessageListener): (() => void) => {
    if (listenerRef.current) {
      worldSocketListeners.delete(listenerRef.current);
    }
    listenerRef.current = listener;
    worldSocketListeners.add(listener);
    return () => {
      worldSocketListeners.delete(listener);
      if (listenerRef.current === listener) {
        listenerRef.current = null;
      }
    };
  }, []);

  return { subscribe, connected };
}

// Polling effect: re-fetch world state periodically after initial load.
// §9.2.3: pause polling while the tab is hidden and immediately refresh when
// it becomes visible again, avoiding wasted background network requests.
// §9.5.1: when the WebSocket is connected, poll less frequently (the WS
// pushes incremental updates in real time); fall back to the short interval
// when the socket is down.
function useWorldStatePolling(
  loaded: boolean,
  request: <T>(url: string) => Promise<T>,
  setData: React.Dispatch<React.SetStateAction<BootstrapData>>,
  wsActive: boolean,
) {
  useEffect(() => {
    if (!loaded) return;

    // §9.5.1: stretch the interval when the WS is active (realtime updates
    // arrive via the socket; polling is just a safety net).
    const POLL_INTERVAL_MS = wsActive ? 30000 : 5000;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const fetchWorldState = async () => {
      await fetchAndApplyWorldState(request, setData);
    };

    const scheduleNext = () => {
      if (timeoutId !== null) return;
      timeoutId = setTimeout(async () => {
        timeoutId = null;
        await fetchWorldState();
        scheduleNext();
      }, POLL_INTERVAL_MS);
    };

    const startPolling = () => {
      scheduleNext();
    };

    const stopPolling = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    // §9.2.3: when the tab becomes hidden, stop the interval; when it becomes
    // visible again, refresh immediately and resume polling.
    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        void fetchWorldState();
        startPolling();
      }
    };

    startPolling();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [loaded, request, setData, wsActive]);
}
