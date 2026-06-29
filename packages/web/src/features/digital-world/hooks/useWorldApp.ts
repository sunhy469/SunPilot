import { useEffect, useRef, type RefObject } from "react";
import { WorldApp, type WorldAppData } from "../canvas/WorldApp";

export function useWorldApp(
  containerRef: RefObject<HTMLDivElement | null>,
  data?: WorldAppData,
) {
  const worldRef = useRef<WorldApp | null>(null);
  const mountedRef = useRef(false);
  // Batch 5 Phase 1 (§9.5 — load performance): when bootstrap data arrives
  // before PixiJS `app.init()` completes, `setData()` would be skipped (the
  // `mountedRef.current` guard drops it). This ref holds the latest data so
  // it can be applied automatically once `mount()` resolves.
  const pendingDataRef = useRef<WorldAppData | undefined>(undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const world = new WorldApp();
    worldRef.current = world;
    let disposed = false;

    void world.mount(container, data).then(() => {
      if (disposed) {
        world.destroy();
      } else {
        mountedRef.current = true;
        // Batch 5 Phase 1: apply any data that arrived while PixiJS was
        // initializing so the first visible frame reflects real data, not
        // mock data left over from the constructor defaults.
        const pending = pendingDataRef.current;
        if (pending) {
          world.setData(pending);
          pendingDataRef.current = undefined;
        }
      }
    });

    // §9.2.4: debounce resize so high-frequency resize events (e.g. dragging
    // the window edge) don't trigger an expensive grid redraw on every frame.
    let resizeTimer: number | null = null;
    const RESIZE_DEBOUNCE_MS = 200;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (width === 0 || height === 0) {
          // Batch 5 Phase 1: flexbox may not have settled yet when the
          // ResizeObserver fires its initial callback. Re-read the container
          // size on the next animation frame; if it's still 0 the next
          // ResizeObserver callback will handle it.
          requestAnimationFrame(() => {
            if (disposed || !container) return;
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (w > 0 && h > 0) {
              world.resize(w, h);
            }
          });
          return;
        }
        world.resize(width, height);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      worldRef.current = null;
      mountedRef.current = false;
      pendingDataRef.current = undefined;
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      observer.disconnect();
      world.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  // Update WorldApp data when data changes (without recreating the app)
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !data) return;

    if (!mountedRef.current) {
      // PixiJS init still in flight — queue the data; it will be applied
      // automatically once mount() resolves.
      pendingDataRef.current = data;
      return;
    }

    world.setData(data);
  }, [data]);

  return worldRef;
}
