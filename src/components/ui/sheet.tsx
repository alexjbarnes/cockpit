"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** On a wide screen the sheet opens beside this rectangle instead of in the
   *  middle, the way a popover would. Phones always get the bottom sheet. */
  anchor?: DOMRect | null;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  label: string;
}

const WIDE = "(min-width: 640px)";

/** How much of the bottom of the window the on-screen keyboard is covering. */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) return;
    const update = () => setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      setInset(0);
    };
  }, [active]);
  return inset;
}

/**
 * A panel over the page: a sheet rising from the bottom on a phone, a small
 * dialog (or a popover beside `anchor`) on anything wider. Escape and a tap
 * outside close it. The overlay carries `fixed inset-0 z-50`, which is what
 * tells the chat not to treat Escape as "stop Claude" while it is open.
 */
export function Sheet({ open, onClose, anchor, children, className, testId, label }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const inset = useKeyboardInset(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel || !anchor || !window.matchMedia(WIDE).matches) {
      setPlace(null);
      return;
    }
    const gap = 8;
    const { width, height } = panel.getBoundingClientRect();
    const left = Math.max(gap, Math.min(anchor.left, window.innerWidth - width - gap));
    const below = anchor.bottom + gap;
    // Below the anchor when it fits, above it when it does not, and pinned to
    // the window when neither does.
    const top = below + height <= window.innerHeight - gap ? below : Math.max(gap, anchor.top - gap - height);
    setPlace({ left, top });
  }, [open, anchor]);

  if (!open) return null;
  const anchored = !!anchor && place !== null;

  return (
    // The backdrop closes on a tap outside. Escape is handled above.
    <div
      className={cn("fixed inset-0 z-50 flex items-end justify-center sm:items-center", anchored ? "bg-transparent" : "bg-black/50")}
      style={{ paddingBottom: inset }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testId}
        className={cn(
          "flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-xl border bg-card text-card-foreground shadow-xl",
          "pb-[env(safe-area-inset-bottom)] sm:w-[26rem] sm:max-w-[calc(100vw-1rem)] sm:rounded-xl sm:pb-0",
          anchor && "sm:fixed",
          className,
        )}
        style={anchored ? { left: place.left, top: place.top } : anchor ? { visibility: "hidden" } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
