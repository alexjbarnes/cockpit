import { useCallback, useRef } from "react";

/**
 * Persist a nested scroll container's position across navigation, keyed in
 * sessionStorage. Next.js restores window scroll on back-navigation but not
 * nested overflow containers, so a list inside one snaps back to the top.
 *
 * Returns a callback ref — attach it to the scroll container (`ref={scrollRef}`).
 * Keying off the element mounting (rather than the component) means it also
 * works when a page swaps the list out for a detail view on the *same* route
 * (query-param views, e.g. plugins/mcp-servers): the scroller element unmounts
 * and remounts, and we re-attach each time.
 *
 * On attach it restores the saved position (re-pinning as asynchronously-loaded
 * content grows so a list that mounts empty still lands in place; a real user
 * scroll or a timeout aborts), and saves as you scroll. Remove sessionStorage[key]
 * elsewhere to force a fresh top on a deliberate entry (the sidebar does this for
 * "settings-scroll").
 */
export function useScrollRestoration<T extends HTMLElement>(key: string) {
  const detach = useRef<(() => void) | null>(null);

  return useCallback(
    (el: T | null) => {
      // Detach from any previously-attached element (remount / unmount).
      detach.current?.();
      detach.current = null;
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
        // Apply synchronously on attach (before paint, no flash when the content
        // is already tall enough).
        el.scrollTop = target;
        if (Math.abs(el.scrollTop - target) < 2) {
          restoring = false;
        } else {
          // Content is still loading and too short — re-pin each frame as the
          // list grows. A real user scroll (wheel/touch/key, none of which fire
          // from a programmatic scrollTop) aborts immediately.
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
        // Ignore the scroll events our own restore generates.
        if (restoring || saveFrame) return;
        saveFrame = requestAnimationFrame(() => {
          saveFrame = 0;
          sessionStorage.setItem(key, String(el.scrollTop));
        });
      };
      el.addEventListener("scroll", onScroll, { passive: true });

      detach.current = () => {
        const wasRestoring = restoring;
        stopRestore();
        if (saveFrame) cancelAnimationFrame(saveFrame);
        el.removeEventListener("scroll", onScroll);
        // Flush the latest position, but don't clobber the saved target with a
        // clamped value if we detached before the content finished loading.
        if (!wasRestoring) sessionStorage.setItem(key, String(el.scrollTop));
      };
    },
    [key],
  );
}
