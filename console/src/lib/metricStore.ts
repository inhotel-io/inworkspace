import type { Pool, PoolClient } from "pg";
import type { MetricSample, PushResult, SampleKind, SeriesState } from "./metricSamples";

/** A sample as the web admin's dashboards read it (its `x:Metric` shape). */
export type DashboardMetric =
  | { "@type": "Counter" | "Gauge"; metric: string; count: number; timestamp: string }
  | { "@type": "Histogram"; metric: string; count: number; sum: number; timestamp: string };

const SERIES_LOCK = 7_302_026;
const INSERT_CHUNK = 500;

function toDashboard(row: { metric: string; kind: SampleKind; at: Date; count: number; sum: number | null }): DashboardMetric {
  const timestamp = row.at.toISOString();
  if (row.kind === "histogram") return { "@type": "Histogram", metric: row.metric, count: row.count, sum: row.sum ?? 0, timestamp };
  return { "@type": row.kind === "counter" ? "Counter" : "Gauge", metric: row.metric, count: row.count, timestamp };
}

async function insertSamples(client: Pick<PoolClient, "query">, samples: readonly MetricSample[]): Promise<void> {
  for (let start = 0; start < samples.length; start += INSERT_CHUNK) {
    const chunk = samples.slice(start, start + INSERT_CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((sample, index) => {
      values.push(sample.metric, sample.at, sample.kind, sample.count, sample.sum);
      const p = (column: number) => `$${index * 5 + column}`;
      return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)})`;
    });
    await client.query(
      `insert into metric_samples (metric, at, kind, count, sum) values ${tuples.join(", ")}
       on conflict (metric, at) do nothing`,
      values,
    );
  }
}

async function saveStates(client: Pick<PoolClient, "query">, states: readonly SeriesState[]): Promise<void> {
  for (const state of states) {
    await client.query(
      `insert into metric_series (metric, kind, start_ns, count, sum, total_count, total_sum, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (metric) do update set kind = excluded.kind, start_ns = excluded.start_ns, count = excluded.count,
         sum = excluded.sum, total_count = excluded.total_count, total_sum = excluded.total_sum, updated_at = now()`,
      [state.metric, state.kind, state.startNs, state.count, state.sum, state.totalCount, state.totalSum],
    );
  }
}

/**
 * Turns a push into samples against the stored series and saves both, in one transaction. Pushes
 * are applied one at a time, so two at once cannot both count the same increase.
 */
export async function recordSamples(
  pool: Pool,
  compute: (previous: ReadonlyMap<string, SeriesState>) => PushResult,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [SERIES_LOCK]);
    const { rows } = await client.query<{
      metric: string;
      kind: "counter" | "histogram";
      start_ns: string;
      count: number;
      sum: number;
      total_count: number;
      total_sum: number;
    }>("select metric, kind, start_ns, count, sum, total_count, total_sum from metric_series");
    const previous = new Map(
      rows.map((row) => [
        row.metric,
        {
          metric: row.metric,
          kind: row.kind,
          startNs: row.start_ns,
          count: row.count,
          sum: row.sum,
          totalCount: row.total_count,
          totalSum: row.total_sum,
        } satisfies SeriesState,
      ]),
    );
    const { samples, states } = compute(previous);
    await insertSamples(client, samples);
    await saveStates(client, states);
    await client.query("commit");
    return samples.length;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The step between samples for a window: about 360 of them, whole minutes, at least one. */
export function resolutionFor(from: Date, to: Date): number {
  const minutes = Math.ceil((to.getTime() - from.getTime()) / 360 / 60_000);
  return Math.max(1, minutes) * 60_000;
}

/**
 * Samples of the given metrics between `from` and `to`, merged into steps of `resolutionMs`:
 * counters added up, gauges averaged. Histograms keep the first and last total of each step, so the
 * differences the dashboards take between consecutive samples still add up to every increase, and
 * each also gets its last sample before the window, which the first one is measured against.
 */
export async function metricHistory(
  pool: Pool,
  params: { metrics: readonly string[]; from: Date; to: Date; resolutionMs: number },
): Promise<DashboardMetric[]> {
  if (params.metrics.length === 0) return [];
  const step = `${Math.max(1, Math.round(params.resolutionMs / 1000))} seconds`;
  const { rows } = await pool.query<{ metric: string; kind: SampleKind; at: Date; count: number; sum: number | null }>(
    `with windowed as (
       select metric, kind, at, count, sum, date_bin($4::interval, at, timestamptz '2000-01-01') as step
       from metric_samples
       where metric = any($1::text[]) and at >= $2 and at <= $3
     ),
     merged as (
       select metric, kind, max(at) as at,
              case when kind = 'counter' then sum(count) else avg(count) end as count,
              null::double precision as sum
       from windowed where kind in ('counter', 'gauge')
       group by metric, kind, step
     ),
     histograms as (
       select metric, kind, at, count, sum from (
         select metric, kind, at, count, sum,
                row_number() over (partition by metric, step order by at) as first_in_step,
                row_number() over (partition by metric, step order by at desc) as last_in_step
         from windowed where kind = 'histogram'
       ) ranked
       where first_in_step = 1 or last_in_step = 1
     ),
     baselines as (
       select distinct on (metric) metric, kind, at, count, sum
       from metric_samples
       where metric = any($1::text[]) and kind = 'histogram' and at < $2
       order by metric, at desc
     )
     select metric, kind, at, count, sum from merged
     union all select metric, kind, at, count, sum from histograms
     union all select metric, kind, at, count, sum from baselines
     order by at, metric`,
    [params.metrics, params.from, params.to, step],
  );
  return rows.map(toDashboard);
}

/** The newest value of each gauge, if it is recent; a gauge the server stopped sending has none. */
export async function latestGauges(pool: Pool, params: { metrics: readonly string[]; since: Date }): Promise<DashboardMetric[]> {
  if (params.metrics.length === 0) return [];
  const { rows } = await pool.query<{ metric: string; kind: SampleKind; at: Date; count: number; sum: number | null }>(
    `select distinct on (metric) metric, kind, at, count, sum
     from metric_samples
     where metric = any($1::text[]) and kind = 'gauge' and at >= $2
     order by metric, at desc`,
    [params.metrics, params.since],
  );
  return rows.map(toDashboard);
}

/** When the server last pushed, if it ever did. */
export async function lastPushAt(pool: Pool): Promise<Date | null> {
  const { rows } = await pool.query<{ at: Date | null }>("select max(updated_at) as at from metric_series where start_ns <> 'derived'");
  return rows[0]?.at ?? null;
}

/**
 * Deletes samples older than the retention. A histogram's newest old sample stays, since the next
 * sample is measured against it.
 */
export async function pruneMetrics(pool: Pool, retentionDays: number): Promise<number> {
  const result = await pool.query(
    `delete from metric_samples s
     where s.at < now() - make_interval(days => $1)
       and not (s.kind = 'histogram' and s.at = (
         select max(o.at) from metric_samples o
         where o.metric = s.metric and o.kind = 'histogram' and o.at < now() - make_interval(days => $1)
       ))`,
    [retentionDays],
  );
  return result.rowCount ?? 0;
}
