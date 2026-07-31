export interface RunContext {
  jobId: string;
  jobName: string;
  runId: string;
  notifyProviders?: string[];
}

/**
 * Tagged identity behind an MCP bearer token. A plain "RunContext | null" can
 * only say "this is a job" or "this is not a job", which was fine while those
 * were the only two callers. A plain session is a third kind that is neither
 * the assistant nor a job, so the token now carries which one it is.
 */
export type McpCaller =
  | { kind: "assistant" }
  | { kind: "job"; run: RunContext }
  | { kind: "session"; sessionId: string; sessionName: string };

const tokens = new Map<string, McpCaller>();

export function registerAuthToken(token: string): void {
  tokens.set(token, { kind: "assistant" });
}

export function registerRunContext(token: string, ctx: RunContext): void {
  tokens.set(token, { kind: "job", run: ctx });
}

export function registerSessionContext(token: string, sessionId: string, sessionName: string): void {
  tokens.set(token, { kind: "session", sessionId, sessionName });
}

export function lookupCaller(token: string): McpCaller | null {
  return tokens.get(token) ?? null;
}

/**
 * The job run behind a token, or null for an assistant or session caller.
 * Kept as its own lookup (rather than making every caller unwrap McpCaller)
 * so add_inbox_message's existing job attribution reads exactly as it did
 * before the token carried a third kind.
 */
export function lookupRunContext(token: string): RunContext | null {
  const caller = tokens.get(token);
  return caller?.kind === "job" ? caller.run : null;
}

export function isValidToken(token: string): boolean {
  return tokens.has(token);
}

export function clearToken(token: string): void {
  tokens.delete(token);
}
