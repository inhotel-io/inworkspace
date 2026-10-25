import { getConfig, servesIngest } from "@/lib/config";
import { getPool } from "@/lib/db";
import { samplesFromPush } from "@/lib/metricSamples";
import { createMetricsIngestHandler } from "@/lib/metricsIngest";
import { pruneMetrics, recordSamples } from "@/lib/metricStore";
import { countQueuedMessages } from "@/lib/queueCount";

let handler: ((request: Request) => Promise<Response>) | undefined;

function metricsHandler(): (request: Request) => Promise<Response> {
  if (!handler) {
    const config = getConfig();
    const pool = getPool();
    const reader = config.queueReader;
    handler = createMetricsIngestHandler({
      token: config.metricsPushToken,
      record: (metrics) => recordSamples(pool, (previous) => samplesFromPush(metrics, previous)),
      countQueue: reader ? () => countQueuedMessages({ serverUrl: config.jmapUrl, ...reader }) : null,
      prune: () => pruneMetrics(pool, config.metricRetentionDays),
      now: () => Date.now(),
      log: (entry) => console.log(JSON.stringify(entry)),
    });
  }
  return handler;
}

/** The server's OpenTelemetry metrics push (OTLP over HTTP), when METRICS_PUSH_TOKEN is set. */
export async function POST(request: Request): Promise<Response> {
  const config = getConfig();
  if (!servesIngest(config) || !config.metricsPushToken) return new Response(null, { status: 404 });
  return metricsHandler()(request);
}
