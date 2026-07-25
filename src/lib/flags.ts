export interface FeatureFlags {
  codexHarness: boolean;
}

export function getFeatureFlags(): FeatureFlags {
  return {
    codexHarness: process.env.COCKPIT_ENABLE_CODEX === "1",
  };
}
