import { useSyncExternalStore } from "react";
import { PAGE_MODAL_FRAME_NAME } from "@/lib/page-modal";

const subscribe = () => () => {};

/**
 * Whether this document is the one inside the page modal. False on the server
 * and through hydration, so the first paint matches the server's, then fixed
 * for the document's life.
 */
export function useEmbedded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.name === PAGE_MODAL_FRAME_NAME && window.parent !== window,
    () => false,
  );
}
