// Quick labels: one-tap markup for the things said about plans over and over.
// Each carries the sentence the agent is given, so a label is as actionable
// as a typed comment.

export interface PlanLabel {
  id: string;
  /** What the reviewer sees on the button and in their notes. */
  name: string;
  /** What the agent is told. */
  ask: string;
}

export const PLAN_LABELS: readonly PlanLabel[] = [
  { id: "clarify", name: "Clarify this", ask: "This is unclear. Say exactly what will be done and why." },
  { id: "example", name: "Show an example", ask: "Give a concrete example of what this looks like." },
  { id: "tests", name: "Needs tests", ask: "Say how this will be tested, and add the tests to the plan." },
  { id: "simpler", name: "Too complicated", ask: "This is more complicated than it needs to be. Propose the simplest thing that works." },
  {
    id: "patterns",
    name: "Match what exists",
    ask: "Follow the patterns already in the codebase here, and name the existing code you will follow.",
  },
  { id: "alternatives", name: "Consider alternatives", ask: "Say what else you considered here and why this is the better choice." },
  { id: "verify", name: "Verify this", ask: "Check that this is true before relying on it, and say how you checked." },
  { id: "scope", name: "Out of scope", ask: "This is out of scope. Take it out of the plan." },
  { id: "good", name: "Looks good", ask: "This part is right. Keep it as it is." },
];

export function planLabel(id: string | undefined): PlanLabel | undefined {
  return id ? PLAN_LABELS.find((l) => l.id === id) : undefined;
}
