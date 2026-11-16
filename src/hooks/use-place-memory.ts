"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { isRememberedPath, memoryKey, placeForPathname } from "@/lib/places";

/**
 * Records the screen you are on as its place's last screen, so the navigation
 * can bring you back to it. The query is kept: a session's cwd lives there,
 * and so does an Insights tab.
 */
export function usePlaceMemory(): void {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!isRememberedPath(pathname)) return;
    const place = placeForPathname(pathname);
    if (!place || place === "more") return;
    const search = searchParams.toString();
    try {
      sessionStorage.setItem(memoryKey(place), search ? `${pathname}?${search}` : pathname);
    } catch {
      // A private window with storage off simply gets no memory.
    }
  }, [pathname, searchParams]);
}
