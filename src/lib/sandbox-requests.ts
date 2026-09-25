// Permission requests that concern the Bash sandbox itself. Neither kind is ever
// auto-approved: bypass and the plan-mode shortcuts answer ordinary tool calls,
// and a yes to one of these widens the sandbox rather than using it.

/** The tool name the CLI uses for a sandboxed command's request to reach a host
 *  outside the allowed domains. Cockpit raises a request under the same name
 *  for the CLI's terminal dialog asking about it. */
export const NETWORK_ACCESS_TOOL = "SandboxNetworkAccess";

/** A tool call asking to run outside the sandbox (Bash's dangerouslyDisableSandbox). */
export function isSandboxEscape(input: unknown): boolean {
  return !!input && typeof input === "object" && (input as { dangerouslyDisableSandbox?: unknown }).dangerouslyDisableSandbox === true;
}

/** A request whose yes would widen the sandbox: an escape or network access. */
export function widensSandbox(toolName: string, input: unknown): boolean {
  return toolName === NETWORK_ACCESS_TOOL || isSandboxEscape(input);
}
