"use client";

import { Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHistoryModal } from "@/hooks/use-history-modal";
import { PAGE_MODAL_FRAME_NAME, parsePageModalMessage } from "@/lib/page-modal";
import { cn } from "@/lib/utils";

/**
 * Open state for the page modal. The device's Back closes it rather than
 * leaving the page underneath (see useHistoryModal). `onClosed` runs however
 * the modal closed.
 */
export function usePageModal(onClosed?: () => void) {
  const router = useRouter();
  const { value: path, open, close, release } = useHistoryModal<string>(onClosed);

  /** Leave the modal for a page it does not show, such as a session. The
   *  modal's entry becomes that page's, so Back returns to where it opened. */
  const openInApp = useCallback(
    (url: string) => {
      release();
      router.replace(url);
    },
    [release, router],
  );

  return { path, open, close, openInApp };
}

interface PageModalProps {
  /** The page to show, or null when closed. */
  path: string | null;
  onClose: () => void;
  onOpenInApp: (url: string) => void;
}

export function PageModal({ path, onClose, onOpenInApp }: PageModalProps) {
  if (path === null) return null;
  return <PageModalFrame key={path} path={path} onClose={onClose} onOpenInApp={onOpenInApp} />;
}

function PageModalFrame({ path, onClose, onOpenInApp }: { path: string; onClose: () => void; onOpenInApp: (url: string) => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Hidden until the page inside says its embedded layout is up, so its first
  // paint (rendered as a full page, sidebar and all) never shows.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frameRef.current?.contentWindow) return;
      const msg = parsePageModalMessage(e.data);
      if (msg?.type === "ready") setReady(true);
      else if (msg?.type === "close") onClose();
      else if (msg?.type === "open-in-app") onOpenInApp(msg.url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onClose, onOpenInApp]);

  // Take focus from the page underneath: left in the composer, the Escape
  // that closes this would also reach it and stop Claude mid-turn.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative flex h-full w-full flex-col overflow-hidden bg-background outline-none sm:h-[85dvh] sm:max-w-5xl sm:rounded-lg sm:border sm:shadow-lg"
        data-testid="page-modal"
      >
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute top-3 right-3 rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <iframe
          ref={frameRef}
          name={PAGE_MODAL_FRAME_NAME}
          src={path}
          title="Cockpit page"
          className={cn("h-full w-full border-0", !ready && "invisible")}
        />
      </div>
    </div>
  );
}
