import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BatchError, canonicalJson, normalizeEvent, parseBatch } from "./normalize";

const batch = readFileSync(new URL("./__fixtures__/webhook-batch.json", import.meta.url), "utf8");
const AGENT = "a21i3v9v@agents.example.test";

function rowOf(type: string) {
  const event = parseBatch(batch).find((candidate) => candidate.type === type);
  if (!event) throw new Error(`fixture has no ${type}`);
  return normalizeEvent(event);
}

describe("parseBatch", () => {
  it("parses the captured batch", () => {
    expect(parseBatch(batch)).toHaveLength(9);
  });

  it("rejects bodies that are not event batches", () => {
    expect(() => parseBatch("{")).toThrow(BatchError);
    expect(() => parseBatch("[]")).toThrow(BatchError);
    expect(() => parseBatch('{"events":{}}')).toThrow(BatchError);
    expect(() => parseBatch('{"events":[{"createdAt":"2026-10-25T11:19:51Z"}]}')).toThrow(BatchError);
    expect(() => parseBatch('{"events":[{"type":"x","createdAt":"yesterday"}]}')).toThrow(BatchError);
  });

  it("accepts an empty batch and a missing data map", () => {
    expect(parseBatch('{"events":[]}')).toEqual([]);
    expect(parseBatch('{"events":[{"type":"x","createdAt":"2026-10-25T11:19:51Z"}]}')[0]?.data).toEqual({});
  });
});

describe("normalizeEvent", () => {
  it("extracts an agent reply", () => {
    const row = rowOf("queue.authenticated-message-queued");
    expect(row.sender).toBe(AGENT);
    expect(row.recipients).toEqual(["jane@example.com"]);
    expect(row.addresses).toEqual([AGENT, "jane@example.com"]);
    expect(row.queueId).toBe("336901658562789888");
    expect(row.severity).toBe("info");
    expect(row.eventAt.toISOString()).toBe("2026-10-25T11:20:29.000Z");
  });

  it("reads a single recipient string and a failure", () => {
    const row = rowOf("delivery.dsn-perm-fail");
    expect(row.recipients).toEqual(["jane@example.com"]);
    expect(row.sender).toBe(AGENT);
    expect(row.severity).toBe("error");
  });

  it("treats the bounce sender <> as no sender", () => {
    const row = rowOf("message-ingest.ham");
    expect(row.sender).toBeNull();
    expect(row.recipients).toEqual([AGENT]);
    expect(row.messageId).toBe("18e1c1d0dd65abfb.7ca47055a21e3adc.fd67714356e8da6c@mail.example.test");
  });

  it("keeps the remote address of a refusal", () => {
    const row = rowOf("smtp.mailbox-does-not-exist");
    expect(row.recipients).toEqual(["ghost@agents.example.test"]);
    expect(row.remoteIp).toBe("192.168.65.1");
    expect(row.severity).toBe("warning");
  });

  it("lowercases addresses and drops duplicates", () => {
    const row = normalizeEvent({
      createdAt: "2026-10-25T11:19:51Z",
      type: "queue.message-queued",
      data: { from: "Jane@Example.com", to: ["A21I3V9V@agents.example.test", "a21i3v9v@agents.example.test"], accountName: "jane@example.com" },
    });
    expect(row.sender).toBe("jane@example.com");
    expect(row.recipients).toEqual([AGENT]);
    expect(row.addresses).toEqual(["jane@example.com", AGENT]);
  });

  it("hashes equal events equally, whatever the key order", () => {
    const a = normalizeEvent({ createdAt: "2026-10-25T11:19:51Z", type: "t", data: { a: 1, b: { c: 2, d: [1, 2] } } });
    const b = normalizeEvent({ createdAt: "2026-10-25T11:19:51Z", type: "t", data: { b: { d: [1, 2], c: 2 }, a: 1 } });
    const c = normalizeEvent({ createdAt: "2026-10-25T11:19:52Z", type: "t", data: { a: 1, b: { c: 2, d: [1, 2] } } });
    expect(a.dedupeHash.equals(b.dedupeHash)).toBe(true);
    expect(a.dedupeHash.equals(c.dedupeHash)).toBe(false);
  });

  it("writes canonical JSON", () => {
    expect(canonicalJson({ b: [2, { y: 1, x: null }], a: "s" })).toBe('{"a":"s","b":[2,{"x":null,"y":1}]}');
  });

  it("keeps the account that ingested a message", () => {
    expect(rowOf("message-ingest.spam").accountId).toBe("1");
    expect(rowOf("queue.authenticated-message-queued").accountId).toBeNull();
  });
});

describe("NUL characters", () => {
  // A remote server's reply text reaches `details` verbatim; Postgres text and jsonb cannot hold NUL.
  it("strips real NUL characters from keys, values and the type", () => {
    const [event] = parseBatch(
      '{"events":[{"type":"delivery.failed\\u0000","createdAt":"2026-10-25T11:20:29Z","data":{"details":"550 \\u0000 no","k\\u0000":["\\u0000x"]}}]}',
    );
    expect(event).toEqual({ type: "delivery.failed", createdAt: "2026-10-25T11:20:29Z", data: { details: "550  no", k: ["x"] } });
  });

  it("keeps a literal backslash-u0000 text intact, and it serializes to valid JSON", () => {
    const [event] = parseBatch('{"events":[{"type":"delivery.failed","createdAt":"2026-10-25T11:20:29Z","data":{"details":"550 \\\\u0000 rejected"}}]}');
    const row = normalizeEvent(event!);
    expect(row.data.details).toBe("550 \\u0000 rejected");
    expect(JSON.parse(JSON.stringify(row.data))).toEqual({ details: "550 \\u0000 rejected" });
  });
});
