// The telemetry read API's query string: present-but-wrong is an error, so a
// typo in a filter cannot quietly return everything.
import { describe, expect, it } from "vitest";
import { parseTelemetryQuery } from "@/lib/telemetry-query";

const parse = (qs: string) => parseTelemetryQuery(new URLSearchParams(qs));

describe("parseTelemetryQuery", () => {
  it("reads every filter and paging option", () => {
    expect(
      parse(
        "session=s&cliSession=c&name=claude_code.api_request&signal=log&since=1&until=2&after=3&limit=50&order=ingest&cursor=10:4&content=inline",
      ),
    ).toEqual({
      query: {
        session: "s",
        cliSession: "c",
        name: "claude_code.api_request",
        signal: "log",
        since: 1,
        until: 2,
        after: 3,
        limit: 50,
        order: "ingest",
        cursor: "10:4",
        content: "inline",
      },
    });
    expect(parse("")).toEqual({ query: {} });
    expect(parse("since=&session=")).toEqual({ query: {} });
  });

  it("refuses values it cannot use", () => {
    expect(parse("signal=metrics")).toEqual({ error: "signal must be one of metric, log, span, span_event" });
    expect(parse("since=yesterday")).toEqual({ error: "since must be a whole number" });
    expect(parse("limit=-1")).toEqual({ error: "limit must be a whole number" });
    expect(parse("limit=0")).toEqual({ error: "limit must be between 1 and 1000" });
    expect(parse("limit=1001")).toEqual({ error: "limit must be between 1 and 1000" });
    expect(parse("order=newest")).toEqual({ error: "order must be time or ingest" });
    expect(parse("cursor=abc")).toEqual({ error: "cursor must be a nextCursor from an earlier page" });
    expect(parse("content=all")).toEqual({ error: "content must be refs or inline" });
    expect(parse("after=99999999999999999999")).toEqual({ error: "after must be a whole number" });
  });
});
