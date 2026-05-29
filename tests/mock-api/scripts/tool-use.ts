import { textResponse, toolUseResponse } from "../builder";
import type { TurnScript } from "../types";

export const toolUseScript: TurnScript[] = [
  {
    events: toolUseResponse("Bash", { command: "ls -la", description: "List all files" }),
  },
  {
    events: textResponse("Here are the files in the directory."),
  },
];
