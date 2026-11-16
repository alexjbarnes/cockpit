// Pictures in an issue's comments and plan. An agent writes one as a markdown
// image whose target is a file on disk: a screenshot it took, a mock-up it
// drew. The file is copied into the issue's own attachments, where it outlives
// the agent's working directory, and the target becomes the address the page
// loads it from. Going the other way, an agent reading the issue is given the
// stored file's path, so it can open the picture it is being asked about.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentHref, attachmentIdFromHref, INLINE_IMAGE_EXTENSIONS, isImagePath, mapImageTargets } from "@/lib/markdown-images";
import type { Issue, IssueAttachment } from "@/types";
import { persistAttachmentFile } from "./issue-storage";

/** A picture larger than this is refused: it is read whole to be told apart
 *  from the ones the issue already holds, and sent whole to the page. */
export const INLINE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** The file a target names, or undefined for one that is not a file of ours to
 *  copy: a link, a data URI, or an address Cockpit already serves. */
function localFile(target: string): string | undefined {
  if (/^file:\/\//i.test(target)) return fileURLToPath(target);
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  if (target.startsWith("/api/")) return undefined;
  if (target.startsWith("~/")) return join(homedir(), target.slice(2));
  if (target.startsWith("/")) return target;
  throw new Error(
    `An image must be given by its absolute path: "${target}" is relative, and there is no directory to read it from. Put it in a code span if it is only text.`,
  );
}

/**
 * Take in the pictures `markdown` names. Each image whose target is a file on
 * disk is copied into the issue's attachments and its target swapped for the
 * address the page loads it from. Returns the issue with those attachments
 * added (not saved: the caller saves it with whatever the text belongs to) and
 * the text to store.
 *
 * The same file is taken in once: by its path when it is already one of the
 * issue's attachments, and by its contents otherwise, so a plan sent again
 * with the same mock-ups stores the same text and makes no new version.
 *
 * Throws for a file that is missing, too large or not an image, so the agent
 * that named it is told rather than leaving a broken picture for the reader.
 */
export function embedImages(issue: Issue, markdown: string, now: number = Date.now()): { issue: Issue; markdown: string } {
  let attachments = issue.attachments;
  const seen = new Map<string, string>();

  const text = mapImageTargets(markdown, (target, alt) => {
    const known = seen.get(target);
    if (known) return known;
    const file = localFile(target);
    if (file === undefined) return target;
    if (!isImagePath(file)) {
      throw new Error(`Only images can be shown in the text (${INLINE_IMAGE_EXTENSIONS.join(", ")}): ${target}`);
    }
    const src = resolve(file);
    let attachment = attachments.find((a) => a.url === src);
    if (!attachment) {
      if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`Image file does not exist: ${target}`);
      if (statSync(src).size > INLINE_IMAGE_MAX_BYTES) throw new Error(`Image is larger than 20 MB: ${target}`);
      const hash = createHash("sha256").update(readFileSync(src)).digest("hex");
      attachment = attachments.find((a) => a.hash === hash);
      if (!attachment) {
        const created: IssueAttachment = {
          id: randomUUID(),
          title: alt.trim() || basename(src),
          url: persistAttachmentFile(issue.key, src),
          createdAt: now,
          inline: true,
          hash,
        };
        attachments = [...attachments, created];
        attachment = created;
      }
    }
    const href = attachmentHref(issue.key, attachment.id);
    seen.set(target, href);
    return href;
  });

  return { issue: attachments === issue.attachments ? issue : { ...issue, attachments }, markdown: text };
}

/**
 * The text as an agent should read it: each picture stored on the issue named
 * by the file it is kept in, which the agent can open, in place of an address
 * only a signed-in browser can load. Sent back unchanged, embedImages turns
 * the path into the same address again.
 */
export function imagesForAgent(issue: Issue, markdown: string): string {
  return mapImageTargets(markdown, (target) => {
    const id = attachmentIdFromHref(issue.key, target);
    const attachment = id ? issue.attachments.find((a) => a.id === id) : undefined;
    return attachment?.url.startsWith("/") ? attachment.url : target;
  });
}
