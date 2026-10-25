import type { Pool, PoolClient } from "pg";
import { summarizeSpan, type DeliveryTrace, type TraceRow } from "./traceEvents";
import { toTraceEvent, type TraceEvent } from "./traceValues";

const INSERT_CHUNK = 500;
const COLUMNS = 5;
/**
 * Batches are stored one at a time, so event ids follow the order batches commit in: a live feed
 * past a cursor never misses an event that commits later with a lower id. It also keeps two
 * batches from regrouping the same span at once.
 */
const TRACE_LOCK = 7_302_027;

export interface RejectedTraceRow {
  row: TraceRow;
  error: string;
}

function isDataError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("22") || code.startsWith("23"));
}

async function insertChunk(client: Pick<PoolClient, "query">, rows: readonly TraceRow[]): Promise<Set<string>> {
  const values: unknown[] = [];
  const tuples = rows.map((row, index) => {
    // parseBatch removed NUL from every value, so this is valid input for jsonb.
    values.push(row.dedupeHash, row.eventAt, row.type, row.spanId, JSON.stringify(row.data));
    const p = (column: number) => `$${index * COLUMNS + column}`;
    return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}::jsonb)`;
  });
  const result = await client.query<{ dedupe_hash: Buffer }>(
    `insert into trace_events (dedupe_hash, event_at, type, span_id, data) values ${tuples.join(", ")}
     on conflict (dedupe_hash) do nothing
     returning dedupe_hash`,
    values,
  );
  return new Set(result.rows.map((row) => row.dedupe_hash.toString("hex")));
}

async function saveTraces(client: Pick<PoolClient, "query">, spanIds: readonly string[]): Promise<void> {
  if (spanIds.length === 0) return;
  const { rows } = await client.query<{ span_id: string; type: string; event_at: Date; data: Record<string, unknown> }>(
    "select span_id, type, event_at, data from trace_events where span_id = any($1::text[]) order by event_at, id",
    [spanIds],
  );
  const bySpan = new Map<string, { type: string; eventAt: Date; data: Record<string, unknown> }[]>();
  for (const row of rows) {
    const list = bySpan.get(row.span_id) ?? [];
    list.push({ type: row.type, eventAt: row.event_at, data: row.data });
    bySpan.set(row.span_id, list);
  }
  for (const [spanId, events] of bySpan) {
    const trace = summarizeSpan(spanId, events);
    if (!trace) continue;
    await client.query(
      `insert into delivery_traces (span_id, kind, started_at, sender, recipients, size, queue_ids, remote_ip, search)
       values ($1, $2, $3, $4, $5::text[], $6, $7::text[], $8, $9)
       on conflict (span_id) do update set kind = excluded.kind, started_at = excluded.started_at, sender = excluded.sender,
         recipients = excluded.recipients, size = excluded.size, queue_ids = excluded.queue_ids,
         remote_ip = excluded.remote_ip, search = excluded.search`,
      [trace.spanId, trace.kind, trace.startedAt, trace.sender, trace.recipients, trace.size, trace.queueIds, trace.remoteIp, trace.search],
    );
  }
}

/**
 * Stores a batch, then regroups the delivery traces of the spans it touched, in one transaction.
 * Returns the rows that were new, so a resent batch is not counted twice. A row Postgres rejects as
 * data must not block the stream, so the batch is then stored row by row and bad rows reported.
 */
export async function insertTraceEvents(
  pool: Pool,
  rows: readonly TraceRow[],
  onRejected?: (rejected: RejectedTraceRow) => void,
): Promise<TraceRow[]> {
  const unique = [...new Map(rows.map((row) => [row.dedupeHash.toString("hex"), row])).values()];
  if (unique.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [TRACE_LOCK]);
    const inserted = new Set<string>();
    try {
      await client.query("savepoint batch");
      for (let start = 0; start < unique.length; start += INSERT_CHUNK) {
        for (const hash of await insertChunk(client, unique.slice(start, start + INSERT_CHUNK))) inserted.add(hash);
      }
    } catch (error) {
      if (!isDataError(error)) throw error;
      await client.query("rollback to savepoint batch");
      inserted.clear();
      for (const row of unique) {
        await client.query("savepoint one");
        try {
          for (const hash of await insertChunk(client, [row])) inserted.add(hash);
          await client.query("release savepoint one");
        } catch (rowError) {
          if (!isDataError(rowError)) throw rowError;
          await client.query("rollback to savepoint one");
          onRejected?.({ row, error: rowError instanceof Error ? rowError.message : String(rowError) });
        }
      }
    }
    const fresh = unique.filter((row) => inserted.has(row.dedupeHash.toString("hex")));
    await saveTraces(client, [...new Set(fresh.map((row) => row.spanId).filter((id): id is string => id !== null))]);
    await client.query("commit");
    return fresh;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface TraceQuery {
  kinds: readonly string[];
  /** Words that must all appear in a trace's addresses, queue ids, remote address or host names. */
  text?: string;
  from?: Date;
  /** Exclusive. */
  until?: Date;
  queueId?: string;
  ascending: boolean;
  position: number;
  anchor?: string;
  anchorOffset: number;
  limit: number;
  calculateTotal: boolean;
}

export class AnchorNotFoundError extends Error {
  constructor() {
    super("the anchor is not in the results");
    this.name = "AnchorNotFoundError";
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The ids of the matching traces, in `x:Trace/query` order and paging. */
export async function queryDeliveryTraces(
  pool: Pool,
  query: TraceQuery,
): Promise<{ ids: string[]; position: number; total: number | null }> {
  const conditions = ["kind = any($1::text[])"];
  const values: unknown[] = [query.kinds];
  const where = (template: string, value: unknown) => {
    values.push(value);
    conditions.push(template.replaceAll("?", `$${values.length}`));
  };
  for (const word of (query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean)) where("search like ?", `%${escapeLike(word)}%`);
  if (query.from) where("started_at >= ?", query.from);
  if (query.until) where("started_at < ?", query.until);
  if (query.queueId) where("? = any(queue_ids)", query.queueId);
  const direction = query.ascending ? "asc" : "desc";
  const ordered = `select span_id, row_number() over (order by started_at ${direction}, span_id ${direction}) - 1 as pos
                   from delivery_traces where ${conditions.join(" and ")}`;

  let position = query.position;
  if (position < 0 && query.anchor === undefined) {
    const counted = await pool.query<{ total: string }>(`with ordered as (${ordered}) select count(*) as total from ordered`, values);
    position = Number(counted.rows[0]!.total) + position;
  }
  position = Math.max(0, position);
  if (query.anchor !== undefined) {
    values.push(query.anchor);
    const { rows } = await pool.query<{ pos: string }>(`with ordered as (${ordered}) select pos from ordered where span_id = $${values.length}`, values);
    values.pop();
    if (rows.length === 0) throw new AnchorNotFoundError();
    position = Math.max(0, Number(rows[0]!.pos) + query.anchorOffset);
  }
  values.push(position, query.limit);
  const { rows } = await pool.query<{ span_id: string; total: string }>(
    `with ordered as (${ordered})
     select span_id, (select count(*) from ordered) as total from ordered
     where pos >= $${values.length - 1} order by pos limit $${values.length}`,
    values,
  );
  let total: number | null = null;
  if (query.calculateTotal) {
    if (rows.length > 0) {
      total = Number(rows[0]!.total);
    } else {
      values.splice(-2);
      const counted = await pool.query<{ total: string }>(`with ordered as (${ordered}) select count(*) as total from ordered`, values);
      total = Number(counted.rows[0]!.total);
    }
  }
  return { ids: rows.map((row) => row.span_id), position, total };
}

export interface StoredTrace extends Omit<DeliveryTrace, "search"> {
  events?: TraceEvent[];
}

/** The traces with these ids, in the order asked; with their events when `withEvents`. */
export async function getDeliveryTraces(pool: Pool, ids: readonly string[], withEvents: boolean): Promise<StoredTrace[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<{
    span_id: string;
    kind: string;
    started_at: Date;
    sender: string | null;
    recipients: string[];
    size: string | null;
    queue_ids: string[];
    remote_ip: string | null;
  }>(
    "select span_id, kind, started_at, sender, recipients, size, queue_ids, remote_ip from delivery_traces where span_id = any($1::text[])",
    [ids],
  );
  const events = new Map<string, TraceEvent[]>();
  if (withEvents && rows.length > 0) {
    const found = await pool.query<{ span_id: string; type: string; event_at: Date; data: Record<string, unknown> }>(
      "select span_id, type, event_at, data from trace_events where span_id = any($1::text[]) order by event_at, id",
      [rows.map((row) => row.span_id)],
    );
    for (const row of found.rows) {
      const list = events.get(row.span_id) ?? [];
      list.push(toTraceEvent(row.type, row.event_at, row.data));
      events.set(row.span_id, list);
    }
  }
  const byId = new Map(
    rows.map((row) => [
      row.span_id,
      {
        spanId: row.span_id,
        kind: row.kind,
        startedAt: row.started_at,
        sender: row.sender,
        recipients: row.recipients,
        size: row.size === null ? null : Number(row.size),
        queueIds: row.queue_ids,
        remoteIp: row.remote_ip,
        ...(withEvents ? { events: events.get(row.span_id) ?? [] } : {}),
      } satisfies StoredTrace,
    ]),
  );
  return ids.flatMap((id) => {
    const trace = byId.get(id);
    return trace ? [trace] : [];
  });
}

export interface LiveQuery {
  /** The cursor of the previous answer; none starts the feed. */
  after?: string;
  keywords: readonly string[];
  /** Event keys and the values they must have, such as ["queueId", "123"]. */
  filters: readonly (readonly [string, string])[];
  /** When starting, events since this time are sent first. */
  since: Date;
  limit: number;
}

const SCAN_LIMIT = 5000;

interface FeedRow {
  id: number;
  type: string;
  event_at: string;
  data: Record<string, unknown>;
}

/**
 * Events after the cursor that match, oldest first, and the cursor to continue from. Each answer
 * is one statement, so its events and its cursor come from the same snapshot.
 */
export async function liveTraceEvents(pool: Pool, query: LiveQuery): Promise<{ cursor: string; events: TraceEvent[] }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const where = (template: string, ...params: unknown[]) => {
    let condition = template;
    for (const param of params) {
      values.push(param);
      condition = condition.replace("?", `$${values.length}`);
    }
    conditions.push(condition);
  };
  for (const keyword of query.keywords) where("(type || ' ' || data::text) ilike ?", `%${escapeLike(keyword)}%`);
  // A key matches its value, or one of its values when it holds a list, such as the recipients.
  for (const [key, value] of query.filters) {
    where(
      `(lower(data ->> ?) = lower(?) or (jsonb_typeof(data -> ?) = 'array'
         and exists (select 1 from jsonb_array_elements_text(data -> ?) as item(value) where lower(item.value) = lower(?))))`,
      key,
      value,
      key,
      key,
      value,
    );
  }
  const matching = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 500);

  const toEvents = (rows: FeedRow[]) => rows.map((row) => toTraceEvent(row.type, new Date(row.event_at), row.data));

  if (query.after === undefined) {
    // Starting: the newest matching events since `since`, and a cursor after everything stored.
    values.push(query.since, limit);
    const { rows } = await pool.query<{ newest: string | null; events: FeedRow[] }>(
      `with recent as (select * from trace_events where event_at >= $${values.length - 1} order by id desc limit ${SCAN_LIMIT}),
            matched as (select id, type, event_at, data from recent ${matching} order by id desc limit $${values.length})
       select (select max(id)::text from trace_events) as newest,
              coalesce((select json_agg(m order by m.id) from matched m), '[]'::json) as events`,
      values,
    );
    return { cursor: rows[0]?.newest ?? "0", events: toEvents(rows[0]?.events ?? []) };
  }

  values.push(query.after, limit);
  const { rows } = await pool.query<{ scanned: string | null; events: FeedRow[] }>(
    `with scanned as (select * from trace_events where id > $${values.length - 1} order by id limit ${SCAN_LIMIT}),
          matched as (select id, type, event_at, data from scanned ${matching} order by id limit $${values.length})
     select (select max(id)::text from scanned) as scanned,
            coalesce((select json_agg(m order by m.id) from matched m), '[]'::json) as events`,
    values,
  );
  const events = rows[0]?.events ?? [];
  // A full page continues after its last event; otherwise after everything looked at.
  const cursor = events.length === limit ? String(events.at(-1)!.id) : (rows[0]?.scanned ?? query.after);
  return { cursor, events: toEvents(events) };
}

export async function pruneTraces(pool: Pool, retentionDays: number): Promise<number> {
  const events = await pool.query("delete from trace_events where event_at < now() - make_interval(days => $1)", [retentionDays]);
  const traces = await pool.query("delete from delivery_traces where started_at < now() - make_interval(days => $1)", [retentionDays]);
  return (events.rowCount ?? 0) + (traces.rowCount ?? 0);
}
