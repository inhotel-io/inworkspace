import { createHash, timingSafeEqual } from "node:crypto";
import { readBody } from "./ingest";
import { decodeMetricsRequest, OtlpError, type OtlpMetric } from "./otlp";

/** A push carries a few hundred metrics; this leaves a wide margin. */
export const MAX_METRICS_BYTES = 4 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const QUEUE_COUNT_METRIC = "queue.count";

export interface MetricsIngestDeps {
  /** The bearer token the server sends with each push. */
  token: string;
  record: (metrics: OtlpMetric[]) => Promise<number>;
  /** Null when no queue reader is configured. */
  countQueue: (() => Promise<number>) | null;
  prune: () => Promise<number>;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

function sameToken(header: string | null, token: string): boolean {
  const given = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "")?.[1];
  if (!given || !token) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(token));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** OTLP/HTTP answers success with an ExportMetricsServiceResponse; an empty one is an empty body. */
function answer(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", ...(status === 200 ? { "Content-Type": "application/x-protobuf" } : {}) },
  });
}

/** The time of the push's newest point, so the queue's size sits with the rest of it. */
function pushTimeNs(metrics: readonly OtlpMetric[], now: number): bigint {
  let latest = 0n;
  for (const metric of metrics) for (const point of metric.points) if (point.timeNs > latest) latest = point.timeNs;
  return latest > 0n ? latest : BigInt(now) * 1_000_000n;
}

/** Handles the server's OpenTelemetry metrics push: token, size, decode, queue size, store. */
export function createMetricsIngestHandler(deps: MetricsIngestDeps): (request: Request) => Promise<Response> {
  let lastPruneAt = Number.NEGATIVE_INFINITY;
  return async (request) => {
    if (!sameToken(request.headers.get("authorization"), deps.token)) {
      deps.log({ severity: "WARNING", message: "console.metrics.bad-token" });
      return answer(401);
    }
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/x-protobuf") {
      deps.log({ severity: "ERROR", message: "console.metrics.unsupported-type", contentType: type ?? null });
      return answer(415);
    }
    const body = await readBody(request, MAX_METRICS_BYTES);
    if (body === null) {
      deps.log({ severity: "ERROR", message: "console.metrics.too-large", limitBytes: MAX_METRICS_BYTES });
      return answer(413);
    }

    let metrics: OtlpMetric[];
    try {
      metrics = decodeMetricsRequest(body);
    } catch (error) {
      if (error instanceof OtlpError) {
        deps.log({ severity: "ERROR", message: "console.metrics.malformed", error: error.message, bytes: body.byteLength });
        return answer(400);
      }
      throw error;
    }

    if (deps.countQueue) {
      try {
        const queued = await deps.countQueue();
        const timeNs = pushTimeNs(metrics, deps.now());
        metrics.push({ name: QUEUE_COUNT_METRIC, kind: "gauge", points: [{ startTimeNs: 0n, timeNs, value: queued }] });
      } catch (error) {
        deps.log({ severity: "WARNING", message: "console.metrics.queue-count-failed", error: messageOf(error) });
      }
    }

    try {
      await deps.record(metrics);
    } catch (error) {
      deps.log({ severity: "ERROR", message: "console.metrics.store-failed", error: messageOf(error), metrics: metrics.length });
      return answer(503);
    }

    const now = deps.now();
    if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      try {
        await deps.prune();
      } catch (error) {
        deps.log({ severity: "ERROR", message: "console.metrics.prune-failed", error: messageOf(error) });
      }
    }
    return answer(200);
  };
}
