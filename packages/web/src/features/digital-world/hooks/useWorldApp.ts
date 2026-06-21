import { useEffect, useRef, type RefObject } from "react";
import { WorldApp, type WorldAppData } from "../canvas/WorldApp";

export function useWorldApp(
  containerRef: RefObject<HTMLDivElement | null>,
  data?: WorldAppData,
) {
  const worldRef = useRef<WorldApp | null>(null);
  const mountedRef = useRef(false);

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
      }
    });

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      world.resize(width, height);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      worldRef.current = null;
      mountedRef.current = false;
      observer.disconnect();
      world.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  // Update WorldApp data when data changes (without recreating the app)
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !data || !mountedRef.current) return;

    world.setData(data);
  }, [data]);

  return worldRef;
}
