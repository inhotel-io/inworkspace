import { apiPreflight, apiRoute } from "@/lib/api";
import { getPool } from "@/lib/db";
import { METRIC_PERMISSIONS, parseMetricIds, parseWindow, unavailableOf, type MetricsResponse } from "@/lib/insights";
import { lastPushAt, metricHistory, resolutionFor } from "@/lib/metricStore";

/** The dashboards' history: `x:Metric` samples between `from` and `to`, merged into about 360 steps. */
export const GET = apiRoute(
  async ({ request }): Promise<MetricsResponse> => {
    const params = new URL(request.url).searchParams;
    const metrics = parseMetricIds(params);
    const { from, to } = parseWindow(params, new Date());
    const pool = getPool();
    const [samples, pushed] = await Promise.all([
      metricHistory(pool, { metrics, from, to, resolutionMs: resolutionFor(from, to) }),
      lastPushAt(pool),
    ]);
    return { metrics: samples, unavailable: unavailableOf(metrics), lastPushAt: pushed?.toISOString() ?? null };
  },
  { permissions: METRIC_PERMISSIONS },
);
export const OPTIONS = apiPreflight;
