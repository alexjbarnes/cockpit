import { shortPath } from "@/lib/path";

/**
 * One line describing what a tool call is about to do, for a permission card
 * and for the notification that says the same thing. It is a lib rather than a
 * component helper because the server builds the notification body with it,
 * where importing React and lucide would be absurd.
 *
 * An empty string means "this tool has nothing worth summarising": the raw
 * input is the only thing that would say, and callers show that instead.
 */
export function formatToolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
    case "bash": {
      const cmd = (input.command as string) || "";
      return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
    }
    case "Write":
    case "write":
    case "Edit":
    case "edit":
    case "Read":
    case "read": {
      const fp = (input.file_path as string) || "";
      return fp ? shortPath(fp) : "";
    }
    // The URL is the whole decision for a fetch, so put it in the summary
    // instead of leaving it to be read out of the raw input JSON.
    case "WebFetch":
    case "WebSearch": {
      const target = (input.url as string) || (input.query as string) || "";
      return target.length > 80 ? target.slice(0, 80) + "..." : target;
    }
    default:
      return "";
  }
}
