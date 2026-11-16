"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { PLACE_ROOTS, type Place, placeForPathname, readRemembered, resolvePlaceTarget } from "@/lib/places";

/**
 * Moving between the navigation's places. Sessions always opens the pinned
 * list, wherever you are; every other place you are not in takes you back to
 * the screen you last had there, and the one you are in takes you to its
 * first screen.
 */
export function usePlaceNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const place = placeForPathname(pathname);

  const go = useCallback(
    (target: Place) => {
      // Sessions is the pinned list, always: your session is one row in it.
      if (target === "sessions") {
        router.push(PLACE_ROOTS.sessions);
        return;
      }
      // Settings always opens at the top, as the old footer button did.
      if (target === "settings") {
        try {
          sessionStorage.removeItem("settings-scroll");
        } catch {}
      }
      router.push(resolvePlaceTarget(target, place, readRemembered(target)));
    },
    [place, router],
  );

  const goMore = useCallback(() => router.push("/more"), [router]);

  return { place, go, goMore };
}
