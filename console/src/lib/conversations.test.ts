import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildThread, directionOf, rolesFromMailboxes, summarizeThreads, type JmapEmail } from "./conversations";
import { htmlToText, sanitizeEmailHtml } from "./sanitize";

const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/jmap-mailbox.json", import.meta.url), "utf8")) as {
  mailboxes: { id: string; role: string | null }[];
  latest: JmapEmail[];
  threads: { id: string; emailIds: string[] }[];
  thread: JmapEmail[];
};
const AGENT = "a21i3v9v@agents.example.test";
const roles = rolesFromMailboxes(fixture.mailboxes);

describe("rolesFromMailboxes", () => {
  it("maps roles to mailbox ids", () => {
    expect(roles).toEqual({ inbox: "a", junk: "c", sent: "e", trash: "b", drafts: "d" });
    expect(rolesFromMailboxes([])).toEqual({ inbox: null, junk: null, sent: null, trash: null, drafts: null });
  });
});

describe("summarizeThreads", () => {
  it("gives every thread a status from its newest message", () => {
    const summaries = summarizeThreads(fixture.latest, fixture.threads, AGENT, roles);
    expect(summaries.map((thread) => [thread.threadId, thread.status, thread.messageCount, thread.counterpart?.email])).toEqual([
      ["d", "answered", 2, "jane@example.com"],
      ["i", "automated", 1, "mailer-daemon@localhost.local"],
      ["g", "junk", 1, "jane@example.com"],
      ["b", "awaiting-reply", 3, "jane@example.com"],
    ]);
    expect(summaries[0]).toMatchObject({ subject: "Re: Parking at the hotel", lastDirection: "outbound", lastActivity: "2026-10-25T11:20:29Z" });
  });

  it("names threads without a subject", () => {
    const [summary] = summarizeThreads([{ ...fixture.latest[3]!, subject: "  " }], fixture.threads, AGENT, roles);
    expect(summary?.subject).toBe("(no subject)");
  });
});

describe("directionOf", () => {
  it("treats Sent or the agent's own address as outbound", () => {
    expect(directionOf(fixture.latest[0]!, AGENT, roles)).toBe("outbound");
    expect(directionOf({ ...fixture.latest[0]!, mailboxIds: { a: true } }, AGENT, roles)).toBe("outbound");
    expect(directionOf(fixture.latest[3]!, AGENT, roles)).toBe("inbound");
  });
});

describe("buildThread", () => {
  const messages = buildThread(fixture.thread, AGENT, roles, { sanitizeHtml: sanitizeEmailHtml, htmlToText });

  it("orders messages by time and marks their direction", () => {
    expect(messages.map((message) => [message.id, message.direction])).toEqual([
      ["eaaaaab", "inbound"],
      ["eaaaaac", "outbound"],
      ["eaaaaaf", "inbound"],
    ]);
  });

  it("keeps text, sanitized HTML and attachment names", () => {
    const [first] = messages;
    expect(first?.text).toBe("Hi, can I check in at 11pm on Friday? Thanks, Jane");
    expect(first?.html).toBe("<p>Hi, can I check in at 11pm on Friday? Thanks, Jane</p><img />");
    expect(first?.attachments).toEqual([{ name: "booking.pdf", size: 20480, type: "application/pdf" }]);
  });

  it("does not treat a text part listed as htmlBody as HTML, and reports truncation", () => {
    expect(messages[1]?.html).toBeNull();
    expect(messages[1]?.truncated).toBe(true);
    expect(messages[2]?.truncated).toBe(false);
  });

  it("falls back to text extracted from HTML", () => {
    const [message] = buildThread(
      [{ ...fixture.thread[1]!, textBody: [] }],
      AGENT,
      roles,
      { sanitizeHtml: sanitizeEmailHtml, htmlToText },
    );
    expect(message?.text).toBe("Hi, can I check in at 11pm on Friday? Thanks, Jane");
  });
});
