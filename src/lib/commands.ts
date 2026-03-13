export interface SlashCommand {
  command: string;
  description: string;
}

export const slashCommands: SlashCommand[] = [
  { command: "/clear", description: "Clear conversation and start fresh" },
  { command: "/compact", description: "Compact conversation context" },
  { command: "/cost", description: "Show token usage" },
  { command: "/context", description: "Show context window usage" },
  { command: "/model", description: "Show or switch model" },
  { command: "/rename", description: "Rename this session" },
  { command: "/commit", description: "Commit changes" },
  { command: "/review", description: "Review code changes" },
  { command: "/help", description: "Show available commands" },
];
