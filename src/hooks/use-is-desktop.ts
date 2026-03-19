import { useState, useEffect } from "react";

const QUERY = "(min-width: 768px)";

export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent) => setDesktop(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return desktop;
}
