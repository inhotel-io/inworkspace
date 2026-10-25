import type { Pool, PoolClient } from "pg";
import { ACCESS_EVENT_TYPES, DELIVERY_PROBLEM_EVENT_TYPES, REFUSAL_EVENT_TYPES, type Severity } from "./eventTypes";
import type { EventRow } from "./normalize";

/** An event as pages and the JSON API see it: serializable, with an ISO time. */
export interface StoredEvent {
  id: number;
  eventAt: string;
  type: string;
  severity: Severity;
  sender: string | null;
  recipients: string[];
  remoteIp: string | null;
  queueId: string | null;
  messageId: string | null;
  data: Record<string, unknown>;
}

export interface EventQuery {
  typePrefix?: string;
  severity?: Severity;
  address?: string;
  since?: Date;
  beforeId?: number;
  afterId?: number;
  limit: number;
}

export interface OverviewCounts {
  received: number;
  junk: number;
  refused: number;
  repliesSent: number;
  repliesDelivered: number;
  deliveryProblems: number;
  accessProblems: number;
}

export interface AgentActivity {
  address: string;
  received: number;
  junk: number;
  repliesSent: number;
  errors: number;
  lastActivity: string | null;
}

const INSERT_CHUNK = 500;
const COLUMNS = 11;
const SELECT_COLUMNS = "id, event_at, type, severity, sender, recipients, remote_ip, queue_id, message_id, data";

export async function insertEvents(pool: Pool, rows: readonly EventRow[]): Promise<number> {
  const unique = [...new Map(rows.map((row) => [row.dedupeHash.toString("hex"), row])).values()];
  if (unique.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query("begin");
    let inserted = 0;
    for (let start = 0; start < unique.length; start += INSERT_CHUNK) {
      inserted += await insertChunk(client, unique.slice(start, start + INSERT_CHUNK));
    }
    await client.query("commit");
    return inserted;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertChunk(client: PoolClient, rows: readonly EventRow[]): Promise<number> {
  const values: unknown[] = [];
  const tuples = rows.map((row, index) => {
    values.push(
      row.dedupeHash,
      row.eventAt,
      row.type,
      row.severity,
      row.sender,
      row.recipients,
      row.addresses,
      row.remoteIp,
      row.queueId,
      row.messageId,
      JSON.stringify(row.data).replaceAll("\\u0000", ""),
    );
    const p = (column: number) => `$${index * COLUMNS + column}`;
    return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}::text[], ${p(7)}::text[], ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}::jsonb)`;
  });
  const result = await client.query(
    `insert into events (dedupe_hash, event_at, type, severity, sender, recipients, addresses, remote_ip, queue_id, message_id, data)
     values ${tuples.join(", ")}
     on conflict (dedupe_hash) do nothing`,
    values,
  );
  return result.rowCount ?? 0;
}

function toStoredEvent(row: Record<string, unknown>): StoredEvent {
  return {
    id: Number(row.id),
    eventAt: (row.event_at as Date).toISOString(),
    type: row.type as string,
    severity: row.severity as Severity,
    sender: (row.sender as string | null) ?? null,
    recipients: (row.recipients as string[] | null) ?? [],
    remoteIp: (row.remote_ip as string | null) ?? null,
    queueId: (row.queue_id as string | null) ?? null,
    messageId: (row.message_id as string | null) ?? null,
    data: row.data as Record<string, unknown>,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Newest first; with `afterId`, the events after it, still returned newest first. */
export async function queryEvents(pool: Pool, query: EventQuery): Promise<StoredEvent[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const where = (template: string, value: unknown) => {
    values.push(value);
    conditions.push(template.replace("?", `$${values.length}`));
  };
  if (query.typePrefix) where("type like ?", `${escapeLike(query.typePrefix)}%`);
  if (query.severity) where("severity = ?", query.severity);
  if (query.address) where("addresses @> array[?]::text[]", query.address.toLowerCase());
  if (query.since) where("event_at >= ?", query.since);
  if (query.beforeId !== undefined) where("id < ?", query.beforeId);
  if (query.afterId !== undefined) where("id > ?", query.afterId);
  const ascending = query.afterId !== undefined;
  values.push(Math.min(Math.max(Math.trunc(query.limit), 1), 500));
  const result = await pool.query(
    `select ${SELECT_COLUMNS} from events
     ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
     order by id ${ascending ? "asc" : "desc"}
     limit $${values.length}`,
    values,
  );
  const events = result.rows.map(toStoredEvent);
  return ascending ? events.reverse() : events;
}

export async function overviewCounts(
  pool: Pool,
  params: { since: Date; agentAddresses: readonly string[]; agentDomains: readonly string[] },
): Promise<OverviewCounts> {
  const result = await pool.query(
    `select
       count(*) filter (where type = 'message-ingest.ham' and recipients && $2::text[]) as received,
       count(*) filter (where type = 'message-ingest.spam' and recipients && $2::text[]) as junk,
       count(*) filter (where type = any($4::text[]) and (
         cardinality(recipients) = 0
         or exists (select 1 from unnest(recipients) as r(address) where split_part(r.address, '@', 2) = any($3::text[]))
       )) as refused,
       count(*) filter (where type = 'queue.authenticated-message-queued' and sender = any($2::text[])) as replies_sent,
       count(*) filter (where type = 'delivery.dsn-success' and sender = any($2::text[])) as replies_delivered,
       count(*) filter (where type = any($5::text[]) and sender = any($2::text[])) as delivery_problems,
       count(*) filter (where type = any($6::text[])) as access_problems
     from events
     where event_at >= $1`,
    [
      params.since,
      [...params.agentAddresses],
      [...params.agentDomains],
      [...REFUSAL_EVENT_TYPES],
      [...DELIVERY_PROBLEM_EVENT_TYPES],
      [...ACCESS_EVENT_TYPES],
    ],
  );
  const row = result.rows[0] as Record<string, string>;
  return {
    received: Number(row.received),
    junk: Number(row.junk),
    refused: Number(row.refused),
    repliesSent: Number(row.replies_sent),
    repliesDelivered: Number(row.replies_delivered),
    deliveryProblems: Number(row.delivery_problems),
    accessProblems: Number(row.access_problems),
  };
}

/** One row per agent, in address order; the last activity looks across the whole retention window. */
export async function agentActivity(
  pool: Pool,
  params: { since: Date; agentAddresses: readonly string[] },
): Promise<AgentActivity[]> {
  if (params.agentAddresses.length === 0) return [];
  const result = await pool.query(
    `select a.address,
       count(e.id) filter (where e.type = 'message-ingest.ham' and a.address = any(e.recipients)) as received,
       count(e.id) filter (where e.type = 'message-ingest.spam' and a.address = any(e.recipients)) as junk,
       count(e.id) filter (where e.type = 'queue.authenticated-message-queued' and e.sender = a.address) as replies_sent,
       count(e.id) filter (where e.severity = 'error') as errors,
       latest.last_activity
     from unnest($2::text[]) as a(address)
     left join events e on e.addresses @> array[a.address] and e.event_at >= $1
     left join lateral (
       select max(l.event_at) as last_activity from events l where l.addresses @> array[a.address]
     ) latest on true
     group by a.address, latest.last_activity
     order by a.address`,
    [params.since, [...params.agentAddresses]],
  );
  return result.rows.map((row) => ({
    address: row.address as string,
    received: Number(row.received),
    junk: Number(row.junk),
    repliesSent: Number(row.replies_sent),
    errors: Number(row.errors),
    lastActivity: row.last_activity ? (row.last_activity as Date).toISOString() : null,
  }));
}

export async function pruneEvents(pool: Pool, retentionDays: number): Promise<number> {
  const result = await pool.query("delete from events where event_at < now() - make_interval(days => $1)", [retentionDays]);
  return result.rowCount ?? 0;
}
