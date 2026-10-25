import type { Pool } from "pg";

export interface Migration {
  version: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: "001_events",
    sql: `
      create table events (
        id          bigserial primary key,
        dedupe_hash bytea       not null unique,
        event_at    timestamptz not null,
        received_at timestamptz not null default now(),
        type        text        not null,
        severity    text        not null check (severity in ('info', 'warning', 'error')),
        sender      text,
        recipients  text[]      not null default '{}',
        addresses   text[]      not null default '{}',
        remote_ip   text,
        queue_id    text,
        message_id  text,
        data        jsonb       not null
      );
      create index events_event_at_idx  on events (event_at desc);
      create index events_type_idx      on events (type, event_at desc);
      create index events_sender_idx    on events (sender, event_at desc);
      create index events_addresses_idx on events using gin (addresses);
    `,
  },
  {
    // message-ingest events list every local recipient of a delivery, so the mailbox that stored
    // the message is identified by the server's account id instead.
    version: "002_events_account",
    sql: `
      alter table events add column account_id bigint;
      create index events_account_idx on events (account_id, event_at desc) where account_id is not null;
    `,
  },
  {
    // The server's metrics, as the web admin's dashboards read them (see metricSamples.ts).
    version: "003_metrics",
    sql: `
      create table metric_samples (
        metric text             not null,
        at     timestamptz      not null,
        kind   text             not null check (kind in ('counter', 'gauge', 'histogram')),
        count  double precision not null,
        sum    double precision,
        primary key (metric, at)
      );
      create index metric_samples_at_idx on metric_samples (at);
      create table metric_series (
        metric      text             primary key,
        kind        text             not null check (kind in ('counter', 'histogram')),
        start_ns    text             not null,
        count       double precision not null,
        sum         double precision not null,
        total_count double precision not null,
        total_sum   double precision not null,
        updated_at  timestamptz      not null default now()
      );
    `,
  },
  {
    // Every event the tracing webhook sends, and the delivery traces grouped from them by span.
    version: "004_traces",
    sql: `
      create table trace_events (
        id          bigserial   primary key,
        dedupe_hash bytea       not null unique,
        event_at    timestamptz not null,
        received_at timestamptz not null default now(),
        type        text        not null,
        span_id     text,
        data        jsonb       not null
      );
      create index trace_events_event_at_idx on trace_events (event_at);
      create index trace_events_span_idx on trace_events (span_id, event_at) where span_id is not null;
      create table delivery_traces (
        span_id    text        primary key,
        kind       text        not null,
        started_at timestamptz not null,
        sender     text,
        recipients text[]      not null default '{}',
        size       bigint,
        queue_ids  text[]      not null default '{}',
        remote_ip  text,
        search     text        not null default ''
      );
      create index delivery_traces_kind_idx on delivery_traces (kind, started_at desc, span_id desc);
    `,
  },
];

const MIGRATION_LOCK = 7_302_025;

/** Applies pending migrations in order, under an advisory lock so that two instances never race. */
export async function migrate(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())",
    );
    const { rows } = await client.query<{ version: string }>("select version from schema_migrations");
    const applied = new Set(rows.map((row) => row.version));
    const newlyApplied: string[] = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query("insert into schema_migrations (version) values ($1)", [migration.version]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      newlyApplied.push(migration.version);
    }
    return newlyApplied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}
