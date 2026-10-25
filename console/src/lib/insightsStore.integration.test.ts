import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addToHistogram, samplesFromPush } from "./metricSamples";
import { latestGauges, metricHistory, pruneMetrics, recordSamples, resolutionFor } from "./metricStore";
import { migrate } from "./migrations";
import { parseBatch } from "./normalize";
import { decodeMetricsRequest, type OtlpMetric } from "./otlp";
import { traceRow, type TraceRow } from "./traceEvents";
import {
  AnchorNotFoundError,
  getDeliveryTraces,
  insertTraceEvents,
  liveTraceEvents,
  pruneTraces,
  queryDeliveryTraces,
  type TraceQuery,
} from "./traceStore";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString: url });
const PUSH = decodeMetricsRequest(new Uint8Array(readFileSync(new URL("./__fixtures__/otlp-metrics.bin", import.meta.url))));
const MS = 1_000_000n;

beforeAll(async () => {
  await pool.query("drop table if exists events, metric_samples, metric_series, trace_events, delivery_traces, schema_migrations");
  await migrate(pool);
});

beforeEach(async () => {
  await pool.query("truncate metric_samples, metric_series, trace_events, delivery_traces restart identity");
});

afterAll(async () => {
  await pool.end();
});

/** The captured push again, `seconds` later, with every counter and histogram grown by `add`. */
function later(seconds: number, add: number): OtlpMetric[] {
  const shift = (time: bigint) => time + BigInt(seconds * 1000) * MS;
  return PUSH.map((metric) => {
    if (metric.kind === "histogram") {
      return { ...metric, points: metric.points.map((p) => ({ ...p, timeNs: shift(p.timeNs), count: p.count + add, sum: p.sum + add * 10 })) };
    }
    if (metric.kind === "sum") return { ...metric, points: metric.points.map((p) => ({ ...p, timeNs: shift(p.timeNs), value: p.value + add })) };
    return { ...metric, points: metric.points.map((p) => ({ ...p, timeNs: shift(p.timeNs) })) };
  });
}

describe("metric store", () => {
  it("keeps counter increases, gauges and histogram totals across pushes", async () => {
    await recordSamples(pool, (previous) => samplesFromPush(PUSH, previous));
    await recordSamples(pool, (previous) => samplesFromPush(later(60, 2), previous));
    const from = new Date("2026-10-25T00:00:00Z");
    const to = new Date("2026-10-27T00:00:00Z");
    const history = await metricHistory(pool, {
      metrics: ["smtp.connection-start", "server.memory", "http.request-time"],
      from,
      to,
      resolutionMs: 60_000,
    });
    const counters = history.filter((m) => m.metric === "smtp.connection-start").map((m) => m.count);
    expect(counters).toEqual([1, 2]);
    expect(history.filter((m) => m.metric === "server.memory").map((m) => m["@type"])).toEqual(["Gauge", "Gauge"]);
    const totals = history.filter((m) => m.metric === "http.request-time").map((m) => [m.count, "sum" in m ? m.sum : null]);
    expect(totals).toEqual([
      [0, 0],
      [2, 4010],
      [4, 4030],
    ]);
  });

  it("merges samples into steps: counters added, gauges averaged, histograms at their first and last total", async () => {
    await recordSamples(pool, (previous) => samplesFromPush(PUSH, previous));
    await recordSamples(pool, (previous) => samplesFromPush(later(20, 1), previous));
    await recordSamples(pool, (previous) => samplesFromPush(later(40, 3), previous));
    const history = await metricHistory(pool, {
      metrics: ["smtp.connection-start", "user.count", "http.request-time"],
      from: new Date("2026-10-25T00:00:00Z"),
      to: new Date("2026-10-27T00:00:00Z"),
      resolutionMs: 3_600_000,
    });
    expect(history.filter((m) => m.metric === "smtp.connection-start").map((m) => m.count)).toEqual([4]);
    expect(history.filter((m) => m.metric === "user.count").map((m) => m.count)).toEqual([1]);
    expect(history.filter((m) => m.metric === "http.request-time").map((m) => m.count)).toEqual([0, 5]);
  });

  it("adds each histogram's last sample before the window as a baseline", async () => {
    await recordSamples(pool, (previous) => samplesFromPush(PUSH, previous));
    await recordSamples(pool, (previous) => samplesFromPush(later(3600, 2), previous));
    const firstAt = new Date(Number(PUSH[0]!.points[0]!.timeNs / MS));
    const history = await metricHistory(pool, {
      metrics: ["http.request-time"],
      from: new Date(firstAt.getTime() + 60_000),
      to: new Date(firstAt.getTime() + 7_200_000),
      resolutionMs: 60_000,
    });
    expect(history.map((m) => m.count)).toEqual([2, 4]);
    expect(history[0]!.timestamp < new Date(firstAt.getTime() + 60_000).toISOString()).toBe(true);
  });

  it("returns the newest recent gauge values", async () => {
    await recordSamples(pool, (previous) => samplesFromPush(PUSH, previous));
    const pushedAt = new Date(Number(PUSH[0]!.points[0]!.timeNs / MS));
    const live = await latestGauges(pool, { metrics: ["server.memory", "smtp.connection-start"], since: new Date(pushedAt.getTime() - 60_000) });
    expect(live).toEqual([{ "@type": "Gauge", metric: "server.memory", count: 107634688, timestamp: pushedAt.toISOString() }]);
    expect(await latestGauges(pool, { metrics: ["server.memory"], since: new Date(pushedAt.getTime() + 1) })).toEqual([]);
  });

  it("records derived histograms next to pushed ones", async () => {
    const at = new Date("2026-10-26T10:00:00Z");
    await recordSamples(pool, (previous) => addToHistogram(previous.get("message-ingest.time"), "message-ingest.time", [{ at, value: 12 }]));
    await recordSamples(pool, (previous) =>
      addToHistogram(previous.get("message-ingest.time"), "message-ingest.time", [{ at: new Date(at.getTime() + 1000), value: 8 }]),
    );
    const history = await metricHistory(pool, {
      metrics: ["message-ingest.time"],
      from: new Date("2026-10-26T00:00:00Z"),
      to: new Date("2026-10-27T00:00:00Z"),
      resolutionMs: 1000,
    });
    expect(history.map((m) => [m.count, "sum" in m ? m.sum : null])).toEqual([
      [0, 0],
      [1, 12],
      [2, 20],
    ]);
  });

  it("prunes old samples but keeps each histogram's newest old one", async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    await pool.query(
      `insert into metric_samples (metric, at, kind, count, sum) values
       ('a', $1, 'counter', 1, null), ('h', $1, 'histogram', 1, 5), ('h', $2, 'histogram', 2, 9), ('g', now(), 'gauge', 3, null)`,
      [old, new Date(old.getTime() + 1000)],
    );
    expect(await pruneMetrics(pool, 90)).toBe(2);
    const { rows } = await pool.query("select metric, count from metric_samples order by metric");
    expect(rows).toEqual([
      { metric: "g", count: 3 },
      { metric: "h", count: 2 },
    ]);
  });

  it("chooses about 360 whole-minute steps", () => {
    const to = new Date("2026-10-26T00:00:00Z");
    expect(resolutionFor(new Date(to.getTime() - 86_400_000), to)).toBe(240_000);
    expect(resolutionFor(new Date(to.getTime() - 90 * 86_400_000), to)).toBe(21_600_000);
    expect(resolutionFor(new Date(to.getTime() - 60_000), to)).toBe(60_000);
  });
});

function event(type: string, second: number, data: Record<string, unknown>): TraceRow {
  return traceRow({ type, createdAt: new Date(Date.UTC(2026, 9, 26, 9, 0, second)).toISOString(), data });
}

function inbound(span: string, second: number, from: string, to: string, queueId: string): TraceRow[] {
  return [
    event("smtp.connection-start", second, { spanId: span, remoteIp: "192.0.2.7" }),
    event("smtp.mail-from", second + 1, { spanId: span, from }),
    event("smtp.rcpt-to", second + 1, { spanId: span, to }),
    event("queue.message-queued", second + 2, { spanId: span, queueId, size: 900 + second, from, to: [to] }),
  ];
}

const QUERY: TraceQuery = { kinds: ["smtp.connection-start"], ascending: false, position: 0, anchorOffset: 0, limit: 25, calculateTotal: true };

describe("trace store", () => {
  it("stores events once and groups them into delivery traces", async () => {
    const rows = [...inbound("11", 0, "jane@example.com", "a@agents.example.test", "901"), event("auth.failed", 3, { remoteIp: "198.51.100.2" })];
    expect(await insertTraceEvents(pool, rows)).toHaveLength(5);
    expect(await insertTraceEvents(pool, rows)).toHaveLength(0);
    const [trace] = await getDeliveryTraces(pool, ["11"], true);
    expect(trace).toMatchObject({
      spanId: "11",
      kind: "smtp.connection-start",
      sender: "jane@example.com",
      recipients: ["a@agents.example.test"],
      size: 900,
      queueIds: ["901"],
      remoteIp: "192.0.2.7",
    });
    expect(trace!.events!.map((e) => e.event)).toEqual(["smtp.connection-start", "smtp.mail-from", "smtp.rcpt-to", "queue.message-queued"]);
  });

  it("completes a trace whose events arrive in later batches", async () => {
    const [start, from, to, queued] = inbound("12", 0, "jane@example.com", "a@agents.example.test", "902");
    await insertTraceEvents(pool, [start!]);
    await insertTraceEvents(pool, [from!, to!, queued!]);
    expect((await getDeliveryTraces(pool, ["12"], false))[0]).toMatchObject({ sender: "jane@example.com", size: 900, queueIds: ["902"] });
  });

  it("queries traces newest first with filters, totals and both kinds of paging", async () => {
    await insertTraceEvents(pool, [
      ...inbound("21", 0, "jane@example.com", "a@agents.example.test", "1001"),
      ...inbound("22", 10, "joe@example.org", "b@agents.example.test", "1002"),
      ...inbound("23", 20, "jane@example.com", "c@agents.example.test", "1003"),
      event("delivery.attempt-start", 30, { spanId: "24", from: "a@agents.example.test", to: ["jane@example.com"], queueId: "1004" }),
    ]);
    expect(await queryDeliveryTraces(pool, QUERY)).toEqual({ ids: ["23", "22", "21"], position: 0, total: 3 });
    expect((await queryDeliveryTraces(pool, { ...QUERY, kinds: ["delivery.attempt-start"] })).ids).toEqual(["24"]);
    expect((await queryDeliveryTraces(pool, { ...QUERY, text: "JANE example" })).ids).toEqual(["23", "21"]);
    expect((await queryDeliveryTraces(pool, { ...QUERY, text: "100%" })).ids).toEqual([]);
    expect((await queryDeliveryTraces(pool, { ...QUERY, queueId: "1002" })).ids).toEqual(["22"]);
    expect((await queryDeliveryTraces(pool, { ...QUERY, from: new Date(Date.UTC(2026, 9, 26, 9, 0, 10)) })).ids).toEqual(["23", "22"]);
    expect((await queryDeliveryTraces(pool, { ...QUERY, until: new Date(Date.UTC(2026, 9, 26, 9, 0, 10)) })).ids).toEqual(["21"]);
    expect((await queryDeliveryTraces(pool, { ...QUERY, ascending: true })).ids).toEqual(["21", "22", "23"]);
    expect(await queryDeliveryTraces(pool, { ...QUERY, position: 1, limit: 1 })).toEqual({ ids: ["22"], position: 1, total: 3 });
    expect(await queryDeliveryTraces(pool, { ...QUERY, anchor: "22", anchorOffset: 1 })).toEqual({ ids: ["21"], position: 2, total: 3 });
    expect(await queryDeliveryTraces(pool, { ...QUERY, position: 9 })).toEqual({ ids: [], position: 9, total: 3 });
    await expect(queryDeliveryTraces(pool, { ...QUERY, anchor: "99" })).rejects.toBeInstanceOf(AnchorNotFoundError);
  });

  it("feeds live events after a cursor, filtered by keywords and keys", async () => {
    const start = await liveTraceEvents(pool, { keywords: [], filters: [], since: new Date(0), limit: 100 });
    expect(start).toEqual({ cursor: "0", events: [] });
    await insertTraceEvents(pool, inbound("31", 0, "jane@example.com", "a@agents.example.test", "1101"));
    const first = await liveTraceEvents(pool, { after: start.cursor, keywords: [], filters: [], since: new Date(0), limit: 100 });
    expect(first.events.map((e) => e.event)).toEqual(["smtp.connection-start", "smtp.mail-from", "smtp.rcpt-to", "queue.message-queued"]);
    expect(first.cursor).toBe("4");
    await insertTraceEvents(pool, inbound("32", 5, "joe@example.org", "b@agents.example.test", "1102"));
    const filtered = await liveTraceEvents(pool, { after: first.cursor, keywords: ["JOE@"], filters: [], since: new Date(0), limit: 100 });
    expect(filtered.events.map((e) => e.event)).toEqual(["smtp.mail-from", "queue.message-queued"]);
    expect(filtered.cursor).toBe("8");
    const byKey = await liveTraceEvents(pool, { after: "0", keywords: [], filters: [["queueId", "1102"]], since: new Date(0), limit: 100 });
    expect(byKey.events).toHaveLength(1);
    const paged = await liveTraceEvents(pool, { after: "0", keywords: [], filters: [], since: new Date(0), limit: 3 });
    expect(paged.cursor).toBe("3");
    const resumed = await liveTraceEvents(pool, { keywords: [], filters: [], since: new Date(Date.UTC(2026, 9, 26, 9, 0, 6)), limit: 100 });
    expect(resumed.cursor).toBe("8");
    expect(resumed.events.map((e) => e.timestamp)).toEqual(["2026-10-26T09:00:06.000Z", "2026-10-26T09:00:06.000Z", "2026-10-26T09:00:07.000Z"]);
  });

  it("parses span ids from real batches exactly", async () => {
    const rows = parseBatch(readFileSync(new URL("./__fixtures__/webhook-batch.json", import.meta.url), "utf8")).map(traceRow);
    await insertTraceEvents(pool, rows);
    const { rows: spans } = await pool.query("select distinct span_id from trace_events where span_id is not null order by span_id");
    expect(spans.map((row) => row.span_id)).toContain("336901507366519296");
  });

  it("prunes old events and traces", async () => {
    await insertTraceEvents(pool, inbound("41", 0, "jane@example.com", "a@agents.example.test", "1201"));
    expect(await pruneTraces(pool, 36_500)).toBe(0);
    await pool.query("update trace_events set event_at = now() - interval '40 days'");
    await pool.query("update delivery_traces set started_at = now() - interval '40 days'");
    expect(await pruneTraces(pool, 30)).toBe(5);
  });
});
