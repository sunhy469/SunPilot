import { useCallback, useEffect, useRef } from "react";

export function useAutoScroll(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

  const shouldAutoScroll = useCallback((container: HTMLElement) => {
    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceToBottom < 120;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      userScrolledRef.current = !shouldAutoScroll(container);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [shouldAutoScroll]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || userScrolledRef.current) return;

    // Use scrollTop for JSDOM compatibility (scrollTo not available on elements in JSDOM)
    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    } else {
      container.scrollTop = container.scrollHeight;
    }
  }, deps);

  return containerRef;
}
