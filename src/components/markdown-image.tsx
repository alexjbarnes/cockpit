"use client";

import { Maximize2, Minimize2, X } from "lucide-react";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * A picture opened over the page it is on. It starts fitted to the screen;
 * pressing it, or the button, shows it at its own size to scroll around, which
 * is how a screenshot is read closely on a phone.
 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [actual, setActual] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="max-w-6xl">
      <div
        className="flex max-h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-background text-foreground shadow-lg"
        data-testid="image-lightbox"
      >
        <div className="flex items-center gap-1 border-b px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm">{alt}</span>
          <button
            type="button"
            onClick={() => setActual((v) => !v)}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid="image-lightbox-size"
          >
            {actual ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {actual ? "Fit to screen" : "Full size"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid="image-lightbox-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-2">
          {/* Pressing the picture does what the button above does. */}
          <img
            src={src}
            alt={alt}
            onClick={() => setActual((v) => !v)}
            className={cn(
              actual ? "max-w-none cursor-zoom-out" : "mx-auto max-h-[calc(100dvh-11rem)] max-w-full cursor-zoom-in object-contain",
            )}
          />
        </div>
      </div>
    </Dialog>
  );
}

type MarkdownImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & { src?: string | Blob; node?: unknown };

/**
 * An image in rendered Markdown, and a picture attached to an issue: shown
 * small where it was written, with its caption under it, and opened over the
 * page when pressed. Opening it in a new tab would leave an installed app for
 * the browser.
 *
 * Everything is a span or a button so it can sit inside the paragraph Markdown
 * puts an image in, and several written together sit side by side.
 */
export function MarkdownImage({ src, alt, node: _node, className, ...props }: MarkdownImageProps) {
  const [open, setOpen] = useState(false);
  if (typeof src !== "string" || !src) return null;
  const caption = alt?.trim() ?? "";
  return (
    <span className="not-prose my-1 mr-2 inline-flex max-w-full flex-col align-top">
      <button
        type="button"
        onClick={(e) => {
          // Not a tap on whatever holds it: in a plan that would select the block.
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={caption ? `Open the picture: ${caption}` : "Open the picture"}
        className="cursor-zoom-in self-start rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="markdown-image"
      >
        <img
          {...props}
          src={src}
          alt={caption}
          loading="lazy"
          className={cn("max-h-72 w-auto max-w-full rounded-md border bg-muted object-contain", className)}
        />
      </button>
      {caption && <span className="mt-1 text-xs text-muted-foreground">{caption}</span>}
      {open && <ImageLightbox src={src} alt={caption} onClose={() => setOpen(false)} />}
    </span>
  );
}
