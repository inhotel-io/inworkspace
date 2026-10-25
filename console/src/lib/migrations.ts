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
