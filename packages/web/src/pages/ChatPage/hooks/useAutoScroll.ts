import { useCallback, useEffect, useRef } from "react";

/**
 * Auto-scroll hook for chat message lists.
 *
 * During streaming (isStreaming=true), uses instant scrollTop assignment
 * to avoid jank from repeated smooth-scroll animations. After streaming
 * completes, uses smooth behavior for a polished final scroll.
 */
export function useAutoScroll(
  deps: unknown[],
  isStreaming = false,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

  const shouldAutoScroll = useCallback((container: HTMLElement) => {
    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceToBottom < 120;
  }, []);

  // Track user scroll intent
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      userScrolledRef.current = !shouldAutoScroll(container);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [shouldAutoScroll]);

  // Auto-scroll on content change
  useEffect(() => {
    const container = containerRef.current;
    if (!container || userScrolledRef.current) return;

    if (typeof container.scrollTo === "function") {
      container.scrollTo({
        top: container.scrollHeight,
        // Instant during streaming to avoid animation jank;
        // smooth on completion for polished feel.
        behavior: isStreaming ? "instant" : "smooth",
      });
    } else {
      // JSDOM fallback (scrollTo not available on elements)
      container.scrollTop = container.scrollHeight;
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return containerRef;
}
