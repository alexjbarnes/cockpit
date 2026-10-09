import { useCallback, useEffect, useRef, useState } from "react";
import { useEmbedded } from "./use-embedded";

/**
 * Open state for a modal that the device's Back closes. Opening pushes a
 * history entry of the modal's own, so Back takes that entry off rather than
 * leaving the page underneath; every other way of closing takes it back off.
 * `onClosed` runs however the modal closed.
 *
 * Inside the page modal's frame the modal is plain state: there a push only
 * replaces (see EmbeddedPageBridge), so the entry would not be its own and
 * taking it off would close the page modal instead.
 */
export function useHistoryModal<T>(onClosed?: () => void) {
  const embedded = useEmbedded();
  const [value, setValue] = useState<T | null>(null);
  const ownsEntry = useRef(false);
  // history.back() is asynchronous: until its popstate arrives, a new entry
  // pushed now would be the one it takes off, so an open waits for it.
  const backPending = useRef(false);
  const entryWanted = useRef(false);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  const pushEntry = useCallback(() => {
    window.history.pushState(window.history.state, "");
    ownsEntry.current = true;
  }, []);

  const open = useCallback(
    (v: T) => {
      setValue(v);
      if (embedded || ownsEntry.current) return;
      if (backPending.current) entryWanted.current = true;
      else pushEntry();
    },
    [embedded, pushEntry],
  );

  const close = useCallback(() => {
    setValue(null);
    entryWanted.current = false;
    if (ownsEntry.current) {
      ownsEntry.current = false;
      backPending.current = true;
      window.history.back();
    }
    onClosedRef.current?.();
  }, []);

  /** Close and leave the modal's entry in place, for a caller that reuses it,
   *  such as by replacing it with another page. */
  const release = useCallback(() => {
    ownsEntry.current = false;
    entryWanted.current = false;
    setValue(null);
    onClosedRef.current?.();
  }, []);

  useEffect(() => {
    const onPopState = () => {
      if (backPending.current) {
        backPending.current = false;
        if (entryWanted.current) {
          entryWanted.current = false;
          pushEntry();
        }
        return;
      }
      // The device's Back, taking the modal's entry off.
      if (!ownsEntry.current) return;
      ownsEntry.current = false;
      setValue(null);
      onClosedRef.current?.();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [pushEntry]);

  return { value, open, close, release };
}
