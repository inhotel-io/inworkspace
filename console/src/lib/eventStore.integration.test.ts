import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertEvents, mailboxActivity, overviewCounts, pruneEvents, queryEvents } from "./eventStore";
import { ACCESS_EVENT_TYPES } from "./eventTypes";
import { migrate } from "./migrations";
import { normalizeEvent, parseBatch, type EventRow } from "./normalize";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString: url });
const MAILBOX = "a21i3v9v@agents.example.test";
const OTHER_MAILBOX = "a000001e@agents.example.test";
const SINCE = new Date("2026-10-25T00:00:00Z");
const rows = parseBatch(readFileSync(new URL("./__fixtures__/webhook-batch.json", import.meta.url), "utf8")).map(normalizeEvent);

function ingest(type: string, accountId: number, at: string): EventRow {
  return normalizeEvent({
    createdAt: at,
    type,
    data: { accountId, messageId: "shared@example.com", from: "jane@example.com", to: [MAILBOX, OTHER_MAILBOX] },
  });
}

beforeAll(async () => {
  await pool.query("drop table if exists events, metric_samples, metric_series, trace_events, delivery_traces, schema_migrations");
  expect(await migrate(pool)).toEqual(["001_events", "002_events_account", "003_metrics", "004_traces"]);
});

beforeEach(async () => {
  await pool.query("truncate events restart identity");
});

afterAll(async () => {
  await pool.end();
});

describe("event store", () => {
  it("applies each migration once", async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it("inserts a batch and ignores a resend of it", async () => {
    expect(await insertEvents(pool, rows)).toBe(9);
    expect(await insertEvents(pool, [...rows, rows[0]!])).toBe(0);
  });

  it("filters by type prefix, severity and address", async () => {
    await insertEvents(pool, rows);
    const deliveries = await queryEvents(pool, { typePrefix: "delivery.", limit: 50 });
    expect(deliveries.map((event) => event.type).sort()).toEqual(["delivery.dsn-perm-fail", "delivery.dsn-success"]);
    const errors = await queryEvents(pool, { severity: "error", limit: 50 });
    expect(errors.map((event) => event.type)).toEqual(["delivery.dsn-perm-fail"]);
    const ghost = await queryEvents(pool, { address: "GHOST@agents.example.test", limit: 50 });
    expect(ghost.map((event) => event.type)).toEqual(["smtp.mailbox-does-not-exist"]);
    expect(await queryEvents(pool, { typePrefix: "queue%", limit: 50 })).toEqual([]);
  });

  it("counts failed sign-ins and new bans as access problems, and finds them by type", async () => {
    const access = (type: string, second: number) =>
      normalizeEvent({ createdAt: `2026-10-25T11:40:0${second}Z`, type, data: { remoteIp: "198.51.100.7" } });
    await insertEvents(pool, [access("auth.failed", 1), access("security.scan-ban", 2), access("security.ip-blocked", 3), access("security.ip-blocked", 4)]);
    const counts = await overviewCounts(pool, { since: SINCE, addresses: [], accountIds: [], domains: [] });
    expect(counts.accessProblems).toBe(2);
    const found = await queryEvents(pool, { types: ACCESS_EVENT_TYPES, limit: 50 });
    expect(found.map((event) => event.type)).toEqual(["security.scan-ban", "auth.failed"]);
  });

  it("returns stored events with exact ids and data", async () => {
    await insertEvents(pool, rows);
    const [reply] = await queryEvents(pool, { typePrefix: "queue.authenticated", limit: 1 });
    expect(reply).toMatchObject({
      type: "queue.authenticated-message-queued",
      severity: "info",
      sender: MAILBOX,
      recipients: ["jane@example.com"],
      queueId: "336901658562789888",
      eventAt: "2026-10-25T11:20:29.000Z",
    });
    expect(reply?.data.queueId).toBe("336901658562789888");
  });

  it("stores text from remote servers that contains a literal backslash-u0000 or NUL", async () => {
    const [event] = parseBatch(
      '{"events":[{"type":"delivery.failed","createdAt":"2026-10-25T11:20:29Z","data":{"details":"550 \\\\u0000 rejected \\u0000"}}]}',
    );
    expect(await insertEvents(pool, [normalizeEvent(event!)])).toBe(1);
    const [stored] = await queryEvents(pool, { limit: 1 });
    expect(stored?.data.details).toBe("550 \\u0000 rejected ");
  });

  it("stores the rest of a batch when one row is invalid", async () => {
    const broken: EventRow = { ...rows[0]!, dedupeHash: Buffer.alloc(32, 7), eventAt: new Date(Number.NaN) };
    const onRejected = vi.fn();
    expect(await insertEvents(pool, [rows[1]!, broken, rows[2]!], onRejected)).toBe(2);
    expect(onRejected).toHaveBeenCalledOnce();
    expect(onRejected.mock.calls[0]![0].row).toBe(broken);
  });

  it("pages newest first, and after an id oldest first", async () => {
    await insertEvents(pool, rows);
    const newest = await queryEvents(pool, { limit: 3 });
    expect(newest.map((event) => event.id)).toEqual([9, 8, 7]);
    const older = await queryEvents(pool, { beforeId: 7, limit: 3 });
    expect(older.map((event) => event.id)).toEqual([6, 5, 4]);
    const newer = await queryEvents(pool, { afterId: 7, limit: 50 });
    expect(newer.map((event) => event.id)).toEqual([9, 8]);
  });

  it("counts the overview", async () => {
    await insertEvents(pool, rows);
    const counts = await overviewCounts(pool, {
      since: SINCE,
      addresses: [MAILBOX],
      accountIds: [1],
      domains: ["agents.example.test"],
    });
    expect(counts).toEqual({
      received: 1,
      junk: 1,
      refused: 1,
      sent: 1,
      delivered: 0,
      deliveryProblems: 1,
      accessProblems: 0,
    });
  });

  it("counts a message to two mailboxes once in each", async () => {
    await insertEvents(pool, [ingest("message-ingest.ham", 1, "2026-10-25T11:30:00Z"), ingest("message-ingest.spam", 2, "2026-10-25T11:30:00Z")]);
    const counts = await overviewCounts(pool, {
      since: SINCE,
      addresses: [MAILBOX, OTHER_MAILBOX],
      accountIds: [1, 2],
      domains: ["agents.example.test"],
    });
    expect(counts).toMatchObject({ received: 1, junk: 1 });
    const activity = await mailboxActivity(pool, {
      since: SINCE,
      mailboxes: [
        { address: MAILBOX, accountId: 1 },
        { address: OTHER_MAILBOX, accountId: 2 },
      ],
    });
    expect(activity.map((row) => [row.address, row.received, row.junk])).toEqual([
      [OTHER_MAILBOX, 0, 1],
      [MAILBOX, 1, 0],
    ]);
  });

  it("reports activity per mailbox, including mailboxes without events", async () => {
    await insertEvents(pool, rows);
    const activity = await mailboxActivity(pool, {
      since: SINCE,
      mailboxes: [
        { address: MAILBOX, accountId: 1 },
        { address: OTHER_MAILBOX, accountId: 2 },
      ],
    });
    expect(activity).toEqual([
      { address: OTHER_MAILBOX, received: 0, junk: 0, sent: 0, errors: 0, lastActivity: null },
      { address: MAILBOX, received: 1, junk: 1, sent: 1, errors: 1, lastActivity: "2026-10-25T11:20:29.000Z" },
    ]);
    expect(await mailboxActivity(pool, { since: SINCE, mailboxes: [] })).toEqual([]);
  });

  it("prunes events older than the retention", async () => {
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await insertEvents(pool, [
      normalizeEvent({ createdAt: at(40), type: "message-ingest.ham", data: { to: MAILBOX } }),
      normalizeEvent({ createdAt: at(1), type: "message-ingest.ham", data: { to: MAILBOX } }),
    ]);
    expect(await pruneEvents(pool, 30)).toBe(1);
    expect(await queryEvents(pool, { limit: 10 })).toHaveLength(1);
  });
});
