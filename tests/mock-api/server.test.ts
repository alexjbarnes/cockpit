import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { textResponse } from "./builder";
import { createMockApiServer, type MockApiServer } from "./server";

describe("mock-api server", () => {
  let server: MockApiServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = await createMockApiServer();
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("rejects /v1/messages without a Bearer token", async () => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 500 when no script is configured", async () => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    expect(res.status).toBe(500);
  });

  it("streams a scripted text response over SSE", async () => {
    server.setScript([{ events: textResponse("Hello from mock") }]);

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain("Hello from mock");
    expect(body).toContain("event: message_stop");
  });

  it("echoes the requested model into message_start when builder is given one", async () => {
    server.setScript([{ events: textResponse("ok", "end_turn", { model: "claude-opus-4-7" }) }]);

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "claude-opus-4-7", messages: [] }),
    });
    const body = await res.text();
    expect(body).toContain(`"model":"claude-opus-4-7"`);
  });

  it("records the request body for assertion", async () => {
    server.setScript([{ events: textResponse("ok") }]);
    await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "ping" }] }),
    });

    const reqs = server.getRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].body).toContain(`"content":"ping"`);
  });

  it("returns 0 tokens from the count_tokens stub", async () => {
    const res = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "ping" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 0 });
  });

  it("404s an unknown endpoint", async () => {
    const res = await fetch(`${baseUrl}/v1/unknown`);
    expect(res.status).toBe(404);
  });

  it("advances through multiple scripted turns", async () => {
    server.setScript([{ events: textResponse("first") }, { events: textResponse("second") }]);

    const r1 = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ messages: [] }),
    });
    const b1 = await r1.text();

    const r2 = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ messages: [] }),
    });
    const b2 = await r2.text();

    expect(b1).toContain("first");
    expect(b2).toContain("second");
  });
});
