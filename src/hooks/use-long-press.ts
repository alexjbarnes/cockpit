import { useCallback, useEffect, useRef } from "react";

const LONG_PRESS_MS = 500;

/**
 * A long press (touch) or right-click (mouse) on one element. iOS Safari fires
 * no contextmenu on a long press, so a held touch is timed here; Android and
 * desktop arrive through contextmenu. Spread `handlers` on the element and
 * return early from its onClick when `swallowClick()` is true, since a click
 * can still follow a long press and must not also act as a tap.
 *
 * A released touch long press also suppresses the browser's synthesised mouse
 * events (mousedown, mouseup, click) at the touch point. They are dispatched at
 * whatever now sits under the finger, which for a long press that opened a
 * modal is the modal itself: the send-mode modal's backdrop closed again on the
 * release-click's mousedown, so the press looked like it did nothing.
 */
export function useLongPress(onLongPress: () => void, enabled: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Every press starts clean, so a long press that no click followed
      // cannot swallow the next real tap.
      fired.current = false;
      cancel();
      if (!enabled || e.pointerType !== "touch") return;
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    [enabled, onLongPress, cancel],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return;
      e.preventDefault();
      cancel();
      if (fired.current) return;
      fired.current = true;
      onLongPress();
    },
    [enabled, onLongPress, cancel],
  );

  const swallowClick = useCallback(() => {
    const was = fired.current;
    fired.current = false;
    return was;
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      cancel();
      // Cancelling touchend is what stops the synthesised mouse events; without
      // it the release clicks whatever the long press just opened.
      if (fired.current) e.preventDefault();
    },
    [cancel],
  );

  return {
    handlers: {
      onPointerDown,
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onContextMenu,
      onTouchEnd,
    },
    swallowClick,
  };
}
