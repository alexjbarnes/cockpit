"use client";

import { useEffect, useState } from "react";

/**
 * Whether the phone's keyboard is open. The app asks the layout viewport to
 * resize with the keyboard (`interactiveWidget: "resizes-content"`), so both
 * it and the visual viewport shrink together; a drop to three quarters of the
 * tallest height seen is the keyboard. Focus is not a good signal: hiding
 * something on focus and showing it again on blur moves the composer as the
 * user taps Send, and the first tap is lost.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let tallest = viewport.height;
    const update = () => {
      tallest = Math.max(tallest, viewport.height);
      setOpen(viewport.height < tallest * 0.75);
    };
    // A rotation is a new tallest, not a keyboard.
    const reset = () => {
      tallest = viewport.height;
      setOpen(false);
    };
    viewport.addEventListener("resize", update);
    window.addEventListener("orientationchange", reset);
    return () => {
      viewport.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", reset);
    };
  }, []);

  return open;
}
