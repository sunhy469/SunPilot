import { useEffect, useState } from "react";

// Task 17 (§9.4.5): responsive breakpoint hook. Returns true when the
// viewport is narrower than 768px (the mobile threshold used to switch
// Drawers to full-screen and the FloatingDock to a horizontal bottom bar).
const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
