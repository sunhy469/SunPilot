import { useEffect, useState } from "react";

/**
 * Lightweight responsive breakpoint hook.
 * Uses matchMedia for instant reactivity without Ant Design's Grid dependency.
 *
 * Breakpoints (matching Ant Design defaults):
 *   xs: < 576px
 *   sm: ≥ 576px
 *   md: ≥ 768px
 *   lg: ≥ 992px
 *   xl: ≥ 1200px
 */
export function useResponsive() {
  const [breakpoint, setBreakpoint] = useState<"xs" | "sm" | "md" | "lg" | "xl">(
    () => getBreakpoint(),
  );

  useEffect(() => {
    const queries = [
      { bp: "xs" as const, mq: window.matchMedia("(max-width: 575px)") },
      { bp: "sm" as const, mq: window.matchMedia("(min-width: 576px) and (max-width: 767px)") },
      { bp: "md" as const, mq: window.matchMedia("(min-width: 768px) and (max-width: 991px)") },
      { bp: "lg" as const, mq: window.matchMedia("(min-width: 992px) and (max-width: 1199px)") },
      { bp: "xl" as const, mq: window.matchMedia("(min-width: 1200px)") },
    ];

    const update = () => setBreakpoint(getBreakpoint());
    for (const { mq } of queries) {
      mq.addEventListener("change", update);
    }
    return () => {
      for (const { mq } of queries) {
        mq.removeEventListener("change", update);
      }
    };
  }, []);

  return {
    breakpoint,
    isMobile: breakpoint === "xs",
    isTablet: breakpoint === "sm" || breakpoint === "md",
    isDesktop: breakpoint === "lg" || breakpoint === "xl",
    isCompact: breakpoint === "xs" || breakpoint === "sm",
  };
}

function getBreakpoint(): "xs" | "sm" | "md" | "lg" | "xl" {
  const width = typeof window !== "undefined" ? window.innerWidth : 1024;
  if (width < 576) return "xs";
  if (width < 768) return "sm";
  if (width < 992) return "md";
  if (width < 1200) return "lg";
  return "xl";
}
