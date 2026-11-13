import { describe, expect, it } from "vitest";
import { userEnv } from "@/server/child-env";

describe("userEnv", () => {
  const server = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    NODE_ENV: "production",
    PORT: "3001",
    NEXT_DEPLOYMENT_ID: "",
    NEXT_RUNTIME: "nodejs",
    __NEXT_PRIVATE_ORIGIN: "http://localhost:3001",
    NEXT_PRIVATE_WORKER: "1",
    NEXT_PUBLIC_API: "https://example.test",
    COCKPIT_TOKEN: "secret",
    COCKPIT_CONFIG_DIR: "/tmp/cfg",
    COCKPIT_DEBUG: "1",
    COCKPIT_HOOK_URL: "http://127.0.0.1:1",
    COCKPIT_HOOK_TOKEN: "t",
    COCKPIT_SESSION_ID: "s",
    COCKPIT_HOOK_TIMEOUT_MS: "5",
    COCKPIT_PERMISSION_HOOK_TIMEOUT_MS: "9",
    UNSET: undefined,
  };

  it("keeps the server's own variables out of what the user runs", () => {
    const env = userEnv(server);
    // The two that bit: a dev server in a session came up as production, or
    // tried to bind cockpit's own port.
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.COCKPIT_TOKEN, "the auth bypass token is the server's secret").toBeUndefined();
    expect(env.COCKPIT_CONFIG_DIR).toBeUndefined();
    expect(env.COCKPIT_DEBUG).toBeUndefined();
    for (const name of ["NEXT_DEPLOYMENT_ID", "NEXT_RUNTIME", "__NEXT_PRIVATE_ORIGIN", "NEXT_PRIVATE_WORKER"])
      expect(env[name]).toBeUndefined();
  });

  it("keeps everything else, the hook bridge's variables included", () => {
    const env = userEnv(server);
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      // The user's own project settings are not cockpit's to remove.
      NEXT_PUBLIC_API: "https://example.test",
      COCKPIT_HOOK_URL: "http://127.0.0.1:1",
      COCKPIT_HOOK_TOKEN: "t",
      COCKPIT_SESSION_ID: "s",
      COCKPIT_HOOK_TIMEOUT_MS: "5",
      COCKPIT_PERMISSION_HOOK_TIMEOUT_MS: "9",
    });
    expect("UNSET" in env).toBe(false);
  });

  it("reads the process environment by default, and copies it", () => {
    const before = process.env.PORT;
    process.env.PORT = "3999";
    try {
      const env = userEnv();
      expect(env.PORT).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      env.PATH = "changed";
      expect(process.env.PATH).not.toBe("changed");
    } finally {
      if (before === undefined) delete process.env.PORT;
      else process.env.PORT = before;
    }
  });
});
