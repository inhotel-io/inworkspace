import { describe, expect, it } from "vitest";
import { auditLine } from "./audit";
import { describeEvent, formatAddress, formatBytes, formatDateTime, formatRelative } from "./format";

describe("format", () => {
  it("formats times in the configured zone", () => {
    expect(formatDateTime("2026-10-25T11:20:29Z", "UTC")).toBe("25 Oct 2026, 11:20:29");
    // Daylight saving time ends in Zurich at 01:00 UTC that day, so this is CET (UTC+1).
    expect(formatDateTime("2026-10-25T11:20:29Z", "Europe/Zurich")).toBe("25 Oct 2026, 12:20:29");
  });

  it("formats relative times", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    expect(formatRelative("2026-10-25T11:59:40Z", now)).toBe("just now");
    expect(formatRelative("2026-10-25T11:55:00Z", now)).toBe("5 min ago");
    expect(formatRelative("2026-10-25T09:00:00Z", now)).toBe("3 h ago");
    expect(formatRelative("2026-10-22T12:00:00Z", now)).toBe("3 d ago");
  });

  it("formats sizes and addresses", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(20480)).toBe("20.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatAddress({ name: "Jane Guest", email: "jane@example.com" })).toBe("Jane Guest <jane@example.com>");
    expect(formatAddress({ name: null, email: "jane@example.com" })).toBe("jane@example.com");
    expect(formatAddress(undefined)).toBe("unknown");
  });

  it("summarizes an event in one line", () => {
    expect(
      describeEvent({
        sender: "a@agents.example.test",
        recipients: ["jane@example.com"],
        data: { details: "DNS lookup failed: Domain does not accept messages (null MX)" },
      }),
    ).toBe("a@agents.example.test → jane@example.com · DNS lookup failed: Domain does not accept messages (null MX)");
    expect(describeEvent({ sender: null, recipients: [], data: { remoteIp: "192.0.2.1", code: 550 } })).toBe("code 550 · from 192.0.2.1");
  });

  it("names the login a failed sign-in tried, and the page a scan probed", () => {
    expect(
      describeEvent({ sender: null, recipients: [], data: { accountName: "shaggy@example.test", reason: "Account not found", remoteIp: "192.0.2.9" } }),
    ).toBe("as shaggy@example.test · Account not found · from 192.0.2.9");
    expect(describeEvent({ sender: null, recipients: [], data: { path: "/wp-login.php", remoteIp: "192.0.2.10" } })).toBe(
      "asked for /wp-login.php · from 192.0.2.10",
    );
  });

  it("writes one JSON audit line", () => {
    expect(JSON.parse(auditLine({ operator: "alex@example.com", mailbox: "a@example.test", threadId: "b" }, new Date("2026-10-25T12:00:00Z")))).toEqual({
      severity: "NOTICE",
      message: "console.view",
      operator: "alex@example.com",
      mailbox: "a@example.test",
      threadId: "b",
      at: "2026-10-25T12:00:00.000Z",
    });
  });

  it("marks the reads the web app makes by itself", () => {
    const line = JSON.parse(auditLine({ operator: "alex@example.com", mailbox: "a@example.test", automatic: true }, new Date("2026-10-25T12:00:00Z")));
    expect(line).toMatchObject({ mailbox: "a@example.test", threadId: null, automatic: true });
  });
});
