import { describe, expect, it } from "vitest";
import { gateFor } from "./gate";

describe("gateFor", () => {
  it("routes the ingest role to the ingest endpoint only", () => {
    expect(gateFor("/api/ingest/events", { role: "ingest" })).toBe("pass");
    expect(gateFor("/healthz", { role: "ingest" })).toBe("pass");
    expect(gateFor("/", { role: "ingest" })).toBe("not-found");
    expect(gateFor("/api/events", { role: "ingest" })).toBe("not-found");
  });

  it("authenticates every web path and hides the ingest endpoint", () => {
    expect(gateFor("/", { role: "web" })).toBe("authenticate");
    expect(gateFor("/agents/a@b.c", { role: "web" })).toBe("authenticate");
    expect(gateFor("/api/ingest/events", { role: "web" })).toBe("not-found");
    expect(gateFor("/healthz", { role: "web" })).toBe("pass");
  });

  it("serves both in the all role", () => {
    expect(gateFor("/api/ingest/events", { role: "all" })).toBe("pass");
    expect(gateFor("/events", { role: "all" })).toBe("authenticate");
  });
});
