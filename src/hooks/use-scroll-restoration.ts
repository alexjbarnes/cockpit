import { useEffect, useLayoutEffect, useRef } from "react";

// useLayoutEffect on the client (restore before paint, no flash); useEffect on
// the server, where layout effects never run and would otherwise warn.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Persist a nested scroll container's position across route navigations, keyed
 * in sessionStorage. Next.js restores window scroll on back-navigation but not
 * nested overflow containers, so a list inside one snaps back to the top.
 *
 * Attach the returned ref to the scroll container: the position is saved as you
 * scroll and restored on mount. Lists that load their content asynchronously
 * mount too short to reach the saved offset, so the position is re-applied as
 * the content grows until the target is reachable, the user scrolls, or a
 * timeout passes. Remove sessionStorage[key] elsewhere to force a fresh top on a
 * deliberate entry (the sidebar does this for "settings-scroll").
 */
export function useScrollRestoration<T extends HTMLElement>(key: string) {
  const ref = useRef<T | null>(null);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const raw = sessionStorage.getItem(key);
    const target = raw !== null ? Number(raw) : Number.NaN;
    let restoring = Number.isFinite(target) && target > 0;
    let pollId = 0;
    let saveFrame = 0;

    const stopRestore = () => {
      restoring = false;
      if (pollId) cancelAnimationFrame(pollId);
      pollId = 0;
      el.removeEventListener("wheel", stopRestore);
      el.removeEventListener("touchstart", stopRestore);
      el.removeEventListener("keydown", stopRestore);
    };

    if (restoring) {
      // Apply synchronously first (no flash when the content is already tall).
      el.scrollTop = target;
      if (Math.abs(el.scrollTop - target) < 2) {
        restoring = false;
      } else {
        // Content is still loading and too short to reach the offset — re-pin it
        // each frame as the list grows. A real user scroll (wheel/touch/key —
        // none of which fire from a programmatic scrollTop) aborts immediately.
        let frames = 0;
        const poll = () => {
          if (!restoring) return;
          el.scrollTop = target;
          frames++;
          if (Math.abs(el.scrollTop - target) < 2 || frames > 120) {
            stopRestore();
            return;
          }
          pollId = requestAnimationFrame(poll);
        };
        el.addEventListener("wheel", stopRestore, { passive: true });
        el.addEventListener("touchstart", stopRestore, { passive: true });
        el.addEventListener("keydown", stopRestore);
        pollId = requestAnimationFrame(poll);
      }
    }

    const onScroll = () => {
      // Ignore the scroll events our own restore generates; only persist genuine
      // post-restore positions.
      if (restoring || saveFrame) return;
      saveFrame = requestAnimationFrame(() => {
        saveFrame = 0;
        sessionStorage.setItem(key, String(el.scrollTop));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      const wasRestoring = restoring;
      stopRestore();
      if (saveFrame) cancelAnimationFrame(saveFrame);
      el.removeEventListener("scroll", onScroll);
      // Flush the latest position, but don't clobber the saved target with a
      // clamped value if we unmounted before the content finished loading.
      if (!wasRestoring) sessionStorage.setItem(key, String(el.scrollTop));
    };
  }, [key]);

  return ref;
}
