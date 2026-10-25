import { getConfig, servesIngest } from "@/lib/config";
import { getPool } from "@/lib/db";
import { createIngestHandler } from "@/lib/ingest";
import { addToHistogram, type PushResult } from "@/lib/metricSamples";
import { recordSamples } from "@/lib/metricStore";
import { derivedTimes, traceRow } from "@/lib/traceEvents";
import { insertTraceEvents, pruneTraces } from "@/lib/traceStore";

let handler: ((request: Request) => Promise<Response>) | undefined;

function tracesHandler(): (request: Request) => Promise<Response> {
  if (!handler) {
    const config = getConfig();
    const pool = getPool();
    const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
    handler = createIngestHandler({
      signingKey: config.webhookSigningKey,
      toRows: (events) => events.map(traceRow),
      insert: async (rows) => {
        const fresh = await insertTraceEvents(pool, rows, ({ row, error }) =>
          log({ severity: "ERROR", message: "console.traces.row-rejected", type: row.type, eventAt: String(row.eventAt), error }),
        );
        // Latencies the community edition does not export, from the events just stored. The events
        // are kept even when this fails, so the batch is not refused for it.
        const times = derivedTimes(fresh);
        if (times.size > 0) {
          try {
            await recordSamples(pool, (previous) => {
              const result: PushResult = { samples: [], states: [] };
              for (const [metric, observations] of times) {
                const state = previous.get(metric);
                // A server that exports this latency itself is not counted twice.
                if (state && state.startNs !== "derived") continue;
                const added = addToHistogram(state, metric, observations);
                result.samples.push(...added.samples);
                result.states.push(...added.states);
              }
              return result;
            });
          } catch (error) {
            log({ severity: "ERROR", message: "console.traces.derived-times-failed", error: error instanceof Error ? error.message : String(error) });
          }
        }
        return fresh.length;
      },
      prune: () => pruneTraces(pool, config.traceRetentionDays),
      now: () => Date.now(),
      log,
    });
  }
  return handler;
}

/** The tracing webhook: events grouped into delivery traces, and the live feed's source. */
export async function POST(request: Request): Promise<Response> {
  if (!servesIngest(getConfig())) return new Response(null, { status: 404 });
  return tracesHandler()(request);
}
