"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import {
  ISSUES_SIDE_ROOTS,
  PLACE_ROOTS,
  type Place,
  placeForPathname,
  readIssuesSide,
  readRemembered,
  resolvePlaceTarget,
} from "@/lib/places";

/**
 * Moving between the navigation's places. On a phone Sessions opens the pinned
 * list, since there is no sidebar to hold it. On a desktop it opens the
 * session you last had, beside the sidebar that already lists them; with no
 * session to return to it opens the folders. Every other place you are not in
 * takes you back to the screen you last had there, and the one you are in
 * takes you to its first screen. Issues is the exception: its item returns to
 * the side you last had, Issues or Workflows, rather than to the last issue
 * you opened.
 */
export function usePlaceNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const place = placeForPathname(pathname);
  const isDesktop = useIsDesktop();

  const go = useCallback(
    (target: Place) => {
      if (target === "sessions") {
        // A desktop has the pinned list in its sidebar, so Sessions is the
        // session you were last in; a phone has no sidebar, so it is the list.
        if (!isDesktop) {
          router.push(PLACE_ROOTS.sessions);
          return;
        }
        const last = readRemembered("sessions");
        router.push(last?.startsWith("/sessions/") ? last : "/");
        return;
      }
      // Issues and Workflows are the two sides of one place. The item returns
      // to the side you last had rather than the last page you were on, so an
      // issue opened from Workflows does not replace the side with its page.
      if (target === "issues") {
        router.push(ISSUES_SIDE_ROOTS[readIssuesSide()]);
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
    [place, router, isDesktop],
  );

  const goMore = useCallback(() => router.push("/more"), [router]);

  return { place, go, goMore };
}
