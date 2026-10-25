import { apiPreflight, apiRoute } from "@/lib/api";
import { getPool } from "@/lib/db";
import { LIVE_METRIC_PERMISSIONS, parseMetricIds, unavailableOf, type MetricsResponse } from "@/lib/insights";
import { lastPushAt, latestGauges } from "@/lib/metricStore";

/** Gauges older than this are not shown as current: the server has stopped pushing. */
const CURRENT_MS = 5 * 60_000;

/** The dashboards' live cards: the newest value of each gauge. */
export const GET = apiRoute(
  async ({ request }): Promise<MetricsResponse> => {
    const metrics = parseMetricIds(new URL(request.url).searchParams);
    const pool = getPool();
    const [samples, pushed] = await Promise.all([
      latestGauges(pool, { metrics, since: new Date(Date.now() - CURRENT_MS) }),
      lastPushAt(pool),
    ]);
    return { metrics: samples, unavailable: unavailableOf(metrics), lastPushAt: pushed?.toISOString() ?? null };
  },
  { permissions: LIVE_METRIC_PERMISSIONS },
);
export const OPTIONS = apiPreflight;
