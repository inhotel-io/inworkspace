import { describe, expect, it } from "vitest";
import eventTypes from "./event-types.json";
import { ACCESS_EVENT_TYPES, DELIVERY_PROBLEM_EVENT_TYPES, REFUSAL_EVENT_TYPES, SUBSCRIBED_EVENT_TYPES, severityOf } from "./eventTypes";

describe("event types", () => {
  it("subscribes to the 39 types in the design", () => {
    expect(SUBSCRIBED_EVENT_TYPES).toHaveLength(39);
    expect(new Set(SUBSCRIBED_EVENT_TYPES).size).toBe(39);
  });

  it("only groups subscribed types", () => {
    for (const group of [eventTypes.error, eventTypes.warning, REFUSAL_EVENT_TYPES, DELIVERY_PROBLEM_EVENT_TYPES, ACCESS_EVENT_TYPES]) {
      for (const type of group) expect(SUBSCRIBED_EVENT_TYPES).toContain(type);
    }
  });

  it("counts failed sign-ins and new bans as access problems, not connections already blocked", () => {
    expect(ACCESS_EVENT_TYPES).toEqual(expect.arrayContaining(["auth.failed", "auth.too-many-attempts", "security.unauthorized", "security.scan-ban"]));
    expect(ACCESS_EVENT_TYPES).not.toContain("security.ip-blocked");
    expect(SUBSCRIBED_EVENT_TYPES).toContain("security.ip-blocked");
  });

  it("never gives a type two severities", () => {
    expect(eventTypes.error.filter((type) => eventTypes.warning.includes(type))).toEqual([]);
  });

  it("derives severity from the type", () => {
    expect(severityOf("delivery.dsn-perm-fail")).toBe("error");
    expect(severityOf("delivery.dsn-temp-fail")).toBe("warning");
    expect(severityOf("message-ingest.spam")).toBe("warning");
    expect(severityOf("smtp.mailbox-does-not-exist")).toBe("warning");
    expect(severityOf("message-ingest.ham")).toBe("info");
    expect(severityOf("something.new")).toBe("info");
  });
});
