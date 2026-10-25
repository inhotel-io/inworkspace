import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBatch } from "./normalize";
import { derivedTimes, summarizeSpan, traceRow, type SpanEvent } from "./traceEvents";

const batch = parseBatch(readFileSync(new URL("./__fixtures__/webhook-batch.json", import.meta.url), "utf8"));
const at = (second: number) => new Date(Date.UTC(2026, 9, 26, 9, 0, second));

describe("traceRow", () => {
  it("keeps the span id exactly and treats span 0 as none", () => {
    const rows = batch.map(traceRow);
    expect(rows[0]).toMatchObject({ type: "queue.message-queued", spanId: "336901507366519296" });
    expect(rows.find((row) => row.type === "queue.authenticated-message-queued")?.spanId).toBeNull();
    expect(new Set(rows.map((row) => row.dedupeHash.toString("hex"))).size).toBe(rows.length);
  });
});

describe("summarizeSpan", () => {
  const session: SpanEvent[] = [
    { type: "smtp.ehlo", eventAt: at(1), data: { domain: "mx.example.com", remoteIp: "192.0.2.7" } },
    { type: "smtp.connection-start", eventAt: at(0), data: { remoteIp: "192.0.2.7", localPort: 25 } },
    { type: "smtp.mail-from", eventAt: at(2), data: { from: "Jane@Example.com" } },
    { type: "smtp.rcpt-to", eventAt: at(3), data: { to: "a@agents.example.test" } },
    { type: "smtp.rcpt-to", eventAt: at(3), data: { to: "b@agents.example.test" } },
    { type: "queue.message-queued", eventAt: at(4), data: { queueId: "336901507433627648", size: 1691, to: ["a@agents.example.test"] } },
  ];

  it("summarizes an inbound session from its events", () => {
    expect(summarizeSpan("7", session)).toEqual({
      spanId: "7",
      kind: "smtp.connection-start",
      startedAt: at(0),
      sender: "jane@example.com",
      recipients: ["a@agents.example.test", "b@agents.example.test"],
      size: 1691,
      queueIds: ["336901507433627648"],
      remoteIp: "192.0.2.7",
      search: "jane@example.com a@agents.example.test b@agents.example.test 336901507433627648 192.0.2.7 mx.example.com",
    });
  });

  it("summarizes an outbound attempt from its first event, not the bounce queued in the same span", () => {
    const attempt = summarizeSpan("9", [
      { type: "delivery.attempt-start", eventAt: at(0), data: { queueId: 5, from: "a@agents.example.test", to: ["jane@example.com"], size: 344 } },
      { type: "delivery.null-mx", eventAt: at(1), data: { domain: "example.com", to: ["jane@example.com"] } },
      { type: "queue.dsn-queued", eventAt: at(1), data: { queueId: 6, from: "<>", to: ["a@agents.example.test"], size: 2547 } },
    ]);
    expect(attempt).toMatchObject({ kind: "delivery.attempt-start", sender: "a@agents.example.test", recipients: ["jane@example.com"], size: 344, queueIds: ["5"] });
  });

  it("is null for spans that are not deliveries", () => {
    expect(summarizeSpan("3", [{ type: "imap.connection-start", eventAt: at(0), data: {} }])).toBeNull();
  });
});

describe("derivedTimes", () => {
  it("reads the elapsed time of stored messages", () => {
    expect(derivedTimes(batch.map(traceRow)).get("message-ingest.time")).toEqual([
      { at: new Date("2026-10-25T11:19:51Z"), value: 1 },
      { at: new Date("2026-10-25T11:20:29Z"), value: 0 },
    ]);
  });

  it("measures indexing and DNS lookups as the server does, counting only lookups that took time", () => {
    const row = (type: string, elapsed: unknown) => traceRow({ type, createdAt: "2026-10-26T09:00:00Z", data: { elapsed } });
    const times = derivedTimes([
      row("message-ingest.search-index", 7),
      row("message-ingest.jmap-append", 2),
      row("delivery.mx-lookup", 12),
      row("mta-sts.policy-fetch", 30),
      row("delivery.ip-lookup", 0),
      row("dane.tlsa-record-fetch", "x"),
      row("smtp.ehlo", 5),
    ]);
    expect([...times].map(([metric, values]) => [metric, values.map((v) => v.value)])).toEqual([
      ["message-ingest.index-time", [7]],
      ["message-ingest.time", [2]],
      ["dns.lookup-time", [12, 30]],
    ]);
  });
});
