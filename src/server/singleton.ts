import { SessionManager } from "./session-manager";

const key = "__aperture_session_manager__";

export function getSessionManager(): SessionManager {
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) {
    g[key] = new SessionManager();
  }
  return g[key] as SessionManager;
}

export function setSessionManager(manager: SessionManager): void {
  (globalThis as Record<string, unknown>)[key] = manager;
}
