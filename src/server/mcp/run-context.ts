export interface RunContext {
  jobId: string;
  jobName: string;
  runId: string;
  notifyProviders?: string[];
}

const tokens = new Map<string, RunContext | null>();

export function registerAuthToken(token: string): void {
  tokens.set(token, null);
}

export function registerRunContext(token: string, ctx: RunContext): void {
  tokens.set(token, ctx);
}

export function isValidToken(token: string): boolean {
  return tokens.has(token);
}

export function lookupRunContext(token: string): RunContext | null {
  return tokens.get(token) ?? null;
}

export function clearToken(token: string): void {
  tokens.delete(token);
}
