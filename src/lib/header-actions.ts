export interface HeaderActionsConfig {
  hideActions?: boolean;
  usageOnly?: boolean;
}

export interface HeaderActionsVisibility {
  /** session-scoped controls: New Terminal, Search, Todo, Background Tasks */
  showSessionActions: boolean;
  /** the account Usage button */
  showUsage: boolean;
}

export function headerActionsVisibility(config: HeaderActionsConfig): HeaderActionsVisibility {
  if (!config) return { showSessionActions: false, showUsage: false };
  if (config.hideActions) return { showSessionActions: false, showUsage: false };
  if (config.usageOnly) return { showSessionActions: false, showUsage: true };
  return { showSessionActions: true, showUsage: true };
}
