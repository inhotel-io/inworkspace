import { describe, expect, it } from "vitest";
import { eventFiltersQuery, parseEventFilters } from "./eventFilters";

const NOW = new Date("2026-10-25T12:00:00Z");
const params = (entries: Record<string, string>) => new URLSearchParams(entries);

describe("parseEventFilters", () => {
  it("defaults to the last 24 hours", () => {
    expect(parseEventFilters(params({}), NOW)).toEqual({ window: "24h", since: new Date("2026-10-24T12:00:00Z") });
  });

  it("accepts valid filters and ignores invalid ones", () => {
    expect(parseEventFilters(params({ type: "delivery.", severity: "error", mailbox: "A@Example.test", window: "7d" }), NOW)).toEqual({
      typePrefix: "delivery.",
      severity: "error",
      address: "a@example.test",
      window: "7d",
      since: new Date("2026-10-18T12:00:00Z"),
    });
    expect(parseEventFilters(params({ type: "x' or 1=1", severity: "panic", mailbox: "nobody", window: "1y" }), NOW)).toEqual({
      window: "24h",
      since: new Date("2026-10-24T12:00:00Z"),
    });
  });

  it("still reads the mailbox from links made before 0.4", () => {
    expect(parseEventFilters(params({ agent: "a@example.test" }), NOW).address).toBe("a@example.test");
  });

  it("ignores windows that are object prototype keys", () => {
    for (const window of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(parseEventFilters(params({ window }), NOW)).toEqual({ window: "24h", since: new Date("2026-10-24T12:00:00Z") });
    }
  });

  it("writes filters back to a query string", () => {
    expect(eventFiltersQuery({ typePrefix: "smtp.", severity: "warning", window: "1h" })).toBe("type=smtp.&severity=warning&window=1h");
    expect(eventFiltersQuery({ address: "a@example.test", window: "24h" })).toBe("mailbox=a%40example.test");
    expect(eventFiltersQuery({ window: "24h" })).toBe("");
  });
});
