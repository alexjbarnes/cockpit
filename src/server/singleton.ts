import type { HookRouter } from "./hook-router";
import type { JobScheduler } from "./job-scheduler";
import type { CockpitMcpServer } from "./mcp/cockpit-config-server";
import { SessionManager } from "./session-manager";
import type { TelemetryService } from "./telemetry/service";
import type { TerminalManager } from "./terminal-manager";
import type { WorkflowEngine } from "./workflow-engine";

const smKey = "__cockpit_session_manager__";
const jsKey = "__cockpit_job_scheduler__";
const weKey = "__cockpit_workflow_engine__";
const tmKey = "__cockpit_terminal_manager__";
const hrKey = "__cockpit_hook_router__";
const mcpKey = "__cockpit_mcp__";
const telemetryKey = "__cockpit_telemetry__";

export function getSessionManager(): SessionManager {
  const g = globalThis as Record<string, unknown>;
  if (!g[smKey]) {
    g[smKey] = new SessionManager();
  }
  return g[smKey] as SessionManager;
}

export function setSessionManager(manager: SessionManager): void {
  (globalThis as Record<string, unknown>)[smKey] = manager;
}

export function getJobScheduler(): JobScheduler | null {
  return ((globalThis as Record<string, unknown>)[jsKey] as JobScheduler) || null;
}

export function setJobScheduler(scheduler: JobScheduler): void {
  (globalThis as Record<string, unknown>)[jsKey] = scheduler;
}

export function getWorkflowEngine(): WorkflowEngine | null {
  return ((globalThis as Record<string, unknown>)[weKey] as WorkflowEngine) || null;
}

export function setWorkflowEngine(engine: WorkflowEngine): void {
  (globalThis as Record<string, unknown>)[weKey] = engine;
}

export function getTerminalManager(): TerminalManager | null {
  return ((globalThis as Record<string, unknown>)[tmKey] as TerminalManager) || null;
}

export function setTerminalManager(manager: TerminalManager): void {
  (globalThis as Record<string, unknown>)[tmKey] = manager;
}

export function getHookRouter(): HookRouter | null {
  return ((globalThis as Record<string, unknown>)[hrKey] as HookRouter) || null;
}

export function setHookRouter(router: HookRouter): void {
  (globalThis as Record<string, unknown>)[hrKey] = router;
}

export function getCockpitMcp(): CockpitMcpServer | null {
  return ((globalThis as Record<string, unknown>)[mcpKey] as CockpitMcpServer) || null;
}

export function setCockpitMcp(server: CockpitMcpServer): void {
  (globalThis as Record<string, unknown>)[mcpKey] = server;
}

/** The telemetry receiver and store. A type-only import above, on purpose:
 *  the routes reach the service through here, and must never pull the
 *  telemetry modules (and with them SQLite) into their bundle. */
export function getTelemetry(): TelemetryService | null {
  return ((globalThis as Record<string, unknown>)[telemetryKey] as TelemetryService) || null;
}

export function setTelemetry(service: TelemetryService): void {
  (globalThis as Record<string, unknown>)[telemetryKey] = service;
}
