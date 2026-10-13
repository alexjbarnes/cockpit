/**
 * One check run as `gh pr checks --json` reports it, and what cockpit makes of
 * it. `bucket` is the CLI's own classification — pass, fail, pending,
 * skipping, cancel — and is what decides the colour; `state` (SUCCESS,
 * IN_PROGRESS, …) is the finer-grained one, kept for what a row might say.
 */
export interface PrCheck {
  name: string;
  state: string;
  bucket: string;
  link: string;
}

export type CheckOutcome = "pass" | "fail" | "pending";

export function checkOutcome(bucket: string): CheckOutcome {
  switch (bucket) {
    case "pass":
    case "skipping":
      return "pass";
    case "fail":
    case "cancel":
      return "fail";
    default:
      // Anything gh has not classified yet is still moving.
      return "pending";
  }
}

export function tallyChecks(checks: PrCheck[]): { passing: number; failing: number; pending: number } {
  const tally = { passing: 0, failing: 0, pending: 0 };
  for (const check of checks) {
    const outcome = checkOutcome(check.bucket);
    if (outcome === "pass") tally.passing += 1;
    else if (outcome === "fail") tally.failing += 1;
    else tally.pending += 1;
  }
  return tally;
}
