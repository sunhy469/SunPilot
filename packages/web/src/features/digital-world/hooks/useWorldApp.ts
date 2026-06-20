import { useEffect, type RefObject } from "react";
import { WorldApp } from "../canvas/WorldApp";

export function useWorldApp(containerRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const world = new WorldApp();
    let disposed = false;

    void world.mount(container).then(() => {
      if (disposed) world.destroy();
    });

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      world.resize(width, height);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      world.destroy();
    };
  }, [containerRef]);
}
